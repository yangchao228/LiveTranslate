// 从仓库 SVG 确定性渲染；复用现有浏览器运行时，不调用图像生成服务。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.resolve(process.argv[2] || path.join(root, 'releases/store-assets'));
(async () => {
  fs.mkdirSync(target, { recursive: true });
  // 句隙规范矢量为图标源；每次渲染先生成启用/停用两组 SVG，避免手工版本漂移。
  const brand = fs.readFileSync(path.join(root, 'assets/brand/mark.svg'), 'utf8');
  const markPaths = [...brand.matchAll(/<path\s+d="([^"]+)"/g)].map(match => `<path d="${match[1]}"/>`).join('');
  if (!markPaths) throw new Error('句隙规范矢量缺少路径');
  for (const size of [16, 48, 128]) {
    for (const disabled of [false, true]) {
      const color = disabled ? '#7d8799' : '#3158bd';
      const prefix = disabled ? 'icon-disabled-' : 'icon-';
      const artwork = `<rect width="64" height="64" rx="14" fill="${color}"/><g fill="#ffffff">${markPaths}</g>`;
      // 商店使用的128像素方形图标，主体96像素并保留四边16像素透明留白。
      const content = size === 128 ? `<g transform="translate(8 8) scale(.75)">${artwork}</g>` : artwork;
      const svg = `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${content}</svg>\n`;
      fs.writeFileSync(path.join(root, 'assets/icons', `${prefix}${size}.svg`), svg);
    }
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const name of fs.readdirSync(path.join(root, 'assets/icons')).filter(name => name.endsWith('.svg'))) {
      const size = Number(name.match(/(\d+)\.svg$/)[1]);
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent('<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>' + fs.readFileSync(path.join(root, 'assets/icons', name), 'utf8'));
      await page.screenshot({ path: path.join(root, 'assets/icons', name.replace('.svg', '.png')), omitBackground: true });
      await page.close();
    }
    const icon = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    const iconSource = fs.readFileSync(path.join(root, 'assets/icons/icon-128.svg'), 'utf8');
    await icon.setContent('<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>' + iconSource);
    await icon.screenshot({ path: path.join(target, 'icon-128.png'), omitBackground: true });
    await icon.close();
    const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
    await page.setContent('<style>html,body{margin:0;padding:0}svg{display:block}</style>' + fs.readFileSync(path.join(root, 'assets/store/small-promo.svg'), 'utf8'));
    await page.screenshot({ path: path.join(target, 'small-promo-440x280.png') });
    await page.close();
    console.log(JSON.stringify({ directory: target, icons: 6, promo: '440x280', renderer: await browser.version() }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
