import { createHash } from 'node:crypto';
import { mkdir, open, link, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient, ApiError } from './client.mjs';
export async function downloadExport(request, id, outputDirectory) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new ApiError('invalid_export_id');
  const job = await request('exports/' + id);
  if (job.data.state !== 'ready') throw new ApiError('export_not_ready');
  const manifest = (await request('exports/' + id + '/download')).data;
  if (!Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 1000) throw new ApiError('invalid_manifest');
  const volumes = new Map(); let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    if (part.index !== index || !Number.isSafeInteger(part.volume) || part.volume < 0 || part.volume > 9999 || !Number.isSafeInteger(part.length) || part.length < 1 || part.length > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new ApiError('invalid_manifest');
    total += part.length;
    if (total > 256 * 1024 * 1024) throw new ApiError('example_download_bound');
    const volume = volumes.get(part.volume) || { length: 0, parts: [] };
    volume.length += part.length; volume.parts.push(part); volumes.set(part.volume, volume);
    if (volume.length > 32 * 1024 * 1024) throw new ApiError('invalid_volume_size');
  }
  const directory = resolve(outputDirectory); await mkdir(directory, { recursive: true });
  const files = []; const partials = []; const published = [];
  try {
    for (const [volume, spec] of volumes) {
      const chunks = [];
      for (const part of spec.parts) {
        const bytes = await request('exports/' + id + '/parts/' + part.index, { raw: true });
        if (bytes.length !== part.length || createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new ApiError('export_integrity_failed');
        chunks.push(bytes);
      }
      const target = resolve(directory, id + '-volume-' + volume + '.csv');
      const temporary = target + '.partial';
      const file = await open(temporary, 'wx', 0o600);
      // Register cleanup only after exclusive creation establishes ownership.
      partials.push(temporary);
      try { await file.writeFile(Buffer.concat(chunks)); }
      finally { await file.close(); }
      files.push({ temporary, target });
    }
    // Keep all volumes partial until every authenticated part has passed its checksum.
    for (const { temporary, target } of files) {
      await link(temporary, target); published.push(target); await rm(temporary);
    }
    return files.map(file => file.target);
  } catch (error) { await Promise.all([...partials, ...published].map(path => rm(path, { force: true }))); throw error; }
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try { console.log(JSON.stringify({ files: await downloadExport(createClient(), process.argv[2] || '', process.argv[3] || './exports') })); }
  catch (error) { console.error(JSON.stringify(error instanceof ApiError ? { code: error.code, status: error.status, ...error.details } : { code: 'download_failed' })); process.exitCode = 1; }
}
