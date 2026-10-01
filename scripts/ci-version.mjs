import fs from 'node:fs';

export function nextVersion(source, published) {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`无效版本号：${value}`);
    const parts = value.split('.').map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part)) || parts[1] > 999 || parts[2] > 999) {
      throw new Error('版本超出安卓版本号范围');
    }
    return parts;
  };
  const a = parse(source);
  const b = parse(published);
  const code = ([major, minor, patch]) => major * 1_000_000 + minor * 1_000 + patch;
  let [major, minor, patch] = code(a) > code(b) ? a : b;
  if (++patch > 999) { patch = 0; minor++; }
  if (minor > 999) { minor = 0; major++; }
  if (code([major, minor, patch]) > 2_147_483_647) throw new Error('安卓版本号已超出范围');
  return `${major}.${minor}.${patch}`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const source = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const response = await fetch('https://43.142.138.108:1316/updates/latest.json', {
    signal: AbortSignal.timeout(30_000), cache: 'no-store'
  });
  if (!response.ok) throw new Error(`无法读取线上版本：HTTP ${response.status}`);
  const published = (await response.json()).version;
  console.log(`version=${nextVersion(source, published)}`);
}
