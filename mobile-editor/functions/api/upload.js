/* ============================================================
   /api/upload —— 图片落盘（契约 §3.5 / §4）
   POST {name, original:{mime,b64}, webp:{b64}|null}
   -> {ok:true, url, webp, path, bytes, commit}

   前端在浏览器里已经把图压好了，后端只做：
     1. 解码 base64
     2. 去重命名：name 已存在就 name-1、name-2…（原图和 webp 兄弟
        同时为空闲名才算可用）
     3. 原图 + webp 兄弟放进**同一次提交**（Git Data API）
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

  let webpBytes = null;
  if (body.webp != null) {
    if (typeof body.webp.b64 !== 'string' || !body.webp.b64) {
      throw new HttpError(400, 'webp.b64 是空的');
    }
    try {
      webpBytes = base64ToBytes(body.webp.b64);
    } catch (e) {
      throw new HttpError(400, 'webp.b64 不是合法 base64');
    }
    if (!webpBytes.length) webpBytes = null;
  }

  // 文件名：去掉目录/空格/禁字；扩展名不合法就用 mime 推断
  let clean = sanitizeFileName(body.name || 'image');
  if (!clean) clean = 'image';
  let { stem, ext } = splitExt(clean);
  if (!ext) ext = extFromMime(original.mime);
  if (!ext || !IMAGE_EXT.has(ext)) throw new HttpError(400, '只支持图片文件（png/jpg/webp/gif/avif）');

  // 去重命名：原图和 webp 兄弟都空闲才算可用
  let finalName = '';
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
    const origPath = `static/images/${candidate}`;
    const webpPath = `static/images/${candidate.replace(/\.[^.]+$/, '')}.webp`;
    const checks = [exists(env, origPath)];
    if (webpBytes && webpPath !== origPath) checks.push(exists(env, webpPath));
    const taken = await Promise.all(checks);
    if (!taken.some(Boolean)) {
      finalName = candidate;
      break;
    }
  }
  if (!finalName) throw new HttpError(409, '重名文件太多，换个名字吧');

  const path = assertWritablePath(`static/images/${finalName}`);
  const files = [{ path, content: originalBytes }];

  let webpPath = null;
  if (webpBytes) {
    webpPath = assertWritablePath(`static/images/${finalName.replace(/\.[^.]+$/, '')}.webp`);
    if (webpPath !== path) files.push({ path: webpPath, content: webpBytes });
    else webpPath = null;
  }

  const result = await commitFiles(env, files, `mobile-editor: 上传图片 ${finalName}`);

  return json({
    ok: true,
    url: '/' + path.replace(/^static\//, ''),
    // webp 兄弟：给了对象 {url,path,bytes}，另附一个 webpUrl 字符串方便前端直接用
    webp: webpPath
      ? { url: '/' + webpPath.replace(/^static\//, ''), path: webpPath, bytes: webpBytes.length }
      : null,
    webpUrl: webpPath ? '/' + webpPath.replace(/^static\//, '') : null,
    path,
    bytes: originalBytes.length,
    commit: result.commit,
  });
}
