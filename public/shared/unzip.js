// Minimal ZIP reader for WhatsApp exports (iPhone shares "WhatsApp Chat - X.zip" containing _chat.txt).
// Uses the browser's built-in DecompressionStream, so no library is needed (Safari 16.4+, Chrome 80+).

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Return the text of the first .txt file in the zip (preferring _chat.txt), or null. */
export async function readTextFromZip(buffer) {
  const buf = new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory record: scan back from the end (it may be followed by a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const txt = entries.filter((e) => /\.txt$/i.test(e.name) && !e.name.startsWith('__MACOSX'));
  const pick = txt.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) || txt[0];
  if (!pick) return null;
  const n = dv.getUint16(pick.local + 26, true);
  const x = dv.getUint16(pick.local + 28, true);
  const start = pick.local + 30 + n + x;
  const data = buf.subarray(start, start + pick.csize);
  const out = pick.method === 0 ? data : pick.method === 8 ? await inflateRaw(data) : null;
  if (!out) throw new Error('Unsupported zip compression');
  return dec.decode(out);
}

/** Read a picked file: .zip (WhatsApp iPhone export) or .txt. */
export async function readChatFile(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (isZip) {
    const text = await readTextFromZip(await file.arrayBuffer());
    if (text == null) throw new Error('No chat text found in this zip');
    return text;
  }
  return await file.text();
}
