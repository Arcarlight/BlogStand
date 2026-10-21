/* ============================================================
   /api/upload —— 图片落盘（契约 §3.5 / §4）
   POST {name, original:{mime,b64}, webp?:{b64}, variants?:[{w,b64}]}
   -> {ok:true, url, path, bytes, variantList:[{w,url,path}], commit}

   前端在浏览器里已经把图压好了，后端只做：
     1. 解码 base64
     2. 去重命名：name 已存在就 name-1、name-2…（原图和所有派生图
        同时为空闲名才算可用）
     3. 原图 + 派生 webp 放进**同一次提交**（Git Data API）

   派生图命名跟站上旧图一致：<原名>-<宽>.webp（tools/build-images.py 的
   规则），所以正文里写的就是 <picture><source srcset="x-350.webp 350w,
   x-700.webp 700w" sizes="350px">。build-images.py 会跳过已经包在
   <picture> 里的图，两边不打架。

   JSON 体积上限 12MB，超了 413。
   ============================================================ */

import {
  HttpError,
  assertWritablePath,
  base64ToBytes,
  commitFiles,
  getFile,
  json,
  readJsonBody,
  sanitizeFileName,
} from './_shared.js';

const MAX_JSON_BYTES = 12 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const MIN_VARIANT_W = 16;
const MAX_VARIANT_W = 4000;
const MAX_VARIANTS = 4;

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return '.png';
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/avif') return '.avif';
  return '';
}

function splitExt(name) {
  const m = String(name).match(/^(.*?)(\.[A-Za-z0-9]+)?$/);
  const stem = (m && m[1]) || 'image';
  const ext = ((m && m[2]) || '').toLowerCase();
  return { stem: stem || 'image', ext };
}

async function exists(env, path) {
  const f = await getFile(env, path);
  return !!f.exists;
}

/** 派生图：{w, bytes}；w 必须是整数、不重复、范围合理 */
function readVariants(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'variants 必须是数组');
  if (raw.length > MAX_VARIANTS) throw new HttpError(400, `最多 ${MAX_VARIANTS} 档派生图`);
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const w = Number(v && v.w);
    if (!Number.isInteger(w) || w < MIN_VARIANT_W || w > MAX_VARIANT_W) {
      throw new HttpError(400, '派生图宽度不合法');
    }
    if (seen.has(w)) continue;
    seen.add(w);
    if (!v || typeof v.b64 !== 'string' || !v.b64) throw new HttpError(400, '派生图数据是空的');
    let bytes;
    try {
      bytes = base64ToBytes(v.b64);
    } catch (e) {
      throw new HttpError(400, '派生图不是合法 base64');
    }
    if (!bytes.length) throw new HttpError(400, '派生图是空的');
    out.push({ w, bytes });
  }
  out.sort((a, b) => a.w - b.w);
  return out;
}

export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request, MAX_JSON_BYTES, '图片太大，最多 12MB');

  const original = body.original;
  if (!original || typeof original.b64 !== 'string' || !original.b64) {
    throw new HttpError(400, '没有收到图片数据');
  }

  let originalBytes;
  try {
    originalBytes = base64ToBytes(original.b64);
  } catch (e) {
    throw new HttpError(400, 'original.b64 不是合法 base64');
  }
  if (!originalBytes.length) throw new HttpError(400, '图片是空的');

  const variants = readVariants(body.variants);

  // 旧版前端只传一个 webp 兄弟：保留兼容（名字不带 -<宽> 后缀）
  let legacyWebp = null;
  if (body.webp != null) {
    if (typeof body.webp.b64 !== 'string' || !body.webp.b64) throw new HttpError(400, 'webp.b64 是空的');
    try {
      legacyWebp = base64ToBytes(body.webp.b64);
    } catch (e) {
      throw new HttpError(400, 'webp.b64 不是合法 base64');
    }
    if (!legacyWebp.length) legacyWebp = null;
  }

  // 文件名：去掉目录/空格/禁字；扩展名不合法就用 mime 推断
  let clean = sanitizeFileName(body.name || 'image');
  if (!clean) clean = 'image';
  let { stem, ext } = splitExt(clean);
  if (!ext) ext = extFromMime(original.mime);
  if (!ext || !IMAGE_EXT.has(ext)) throw new HttpError(400, '只支持图片文件（png/jpg/webp/gif/avif）');

  const pathOf = (candidate) => `static/images/${candidate}`;
  const stemOf = (candidate) => candidate.replace(/\.[^.]+$/, '');

  // 去重命名：原图 + 所有派生图都空闲才算可用
  let finalName = '';
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const paths = [pathOf(candidate)];
    for (const v of variants) paths.push(pathOf(`${stemOf(candidate)}-${v.w}.webp`));
    if (legacyWebp) paths.push(pathOf(`${stemOf(candidate)}.webp`));
    const taken = await Promise.all(paths.map((p) => exists(env, p)));
    if (!taken.some(Boolean)) {
      finalName = candidate;
      break;
    }
  }
  if (!finalName) throw new HttpError(409, '重名文件太多，换个名字吧');

  const files = [];
  const path = assertWritablePath(pathOf(finalName));
  files.push({ path, content: originalBytes });

  const variantList = [];
  for (const v of variants) {
    const vPath = assertWritablePath(pathOf(`${stemOf(finalName)}-${v.w}.webp`));
    if (vPath === path) continue;
    files.push({ path: vPath, content: v.bytes });
    variantList.push({ w: v.w, path: vPath, url: '/' + vPath.replace(/^static\//, '') });
  }

  let legacyPath = null;
  if (legacyWebp) {
    legacyPath = assertWritablePath(pathOf(`${stemOf(finalName)}.webp`));
    if (legacyPath !== path) files.push({ path: legacyPath, content: legacyWebp });
    else legacyPath = null;
  }

  const result = await commitFiles(env, files, `mobile-editor: 上传图片 ${finalName}`);

  const legacyUrl = legacyPath ? '/' + legacyPath.replace(/^static\//, '') : null;
  return json({
    ok: true,
    url: '/' + path.replace(/^static\//, ''),
    path,
    bytes: originalBytes.length,
    // 新版：srcset 用这个
    variantList,
    // 兼容旧字段
    webp: variantList.length
      ? { url: variantList[0].url, path: variantList[0].path }
      : (legacyPath ? { url: legacyUrl, path: legacyPath } : null),
    webpUrl: variantList.length ? variantList[0].url : legacyUrl,
    commit: result.commit,
  });
}
