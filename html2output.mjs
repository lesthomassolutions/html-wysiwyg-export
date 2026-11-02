import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

function findBrowser() {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
    return process.env.BROWSER_PATH;
  }

  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';

  const candidates = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    'Chrome or Edge was not found. Set BROWSER_PATH to the full path of chrome.exe or msedge.exe.'
  );
}

function parseArgs(argv) {
  const args = {
    mode: 'pdf-exact',
    viewportWidth: 2200,
    landscape: true,
    dpi: 600,
    pad: 14,
    selector: '',
    sandbox: true,
    inputs: []
  };

  for (const arg of argv) {
    if (arg === '--pdf-exact') args.mode = 'pdf-exact';
    else if (arg === '--no-sandbox') args.sandbox = false;
    else if (arg.startsWith('--selector=')) args.selector = arg.slice('--selector='.length).trim();
    else if (arg === '--pdf-letter') args.mode = 'pdf-letter';
    else if (arg === '--png') args.mode = 'png';
    else if (arg === '--portrait') args.landscape = false;
    else if (arg === '--landscape') args.landscape = true;
    else if (arg.startsWith('--dpi=')) {
      const n = Number(arg.slice('--dpi='.length));
      if (Number.isFinite(n) && n >= 96 && n <= 1200) args.dpi = Math.round(n);
    } else if (arg.startsWith('--viewport=')) {
      const n = Number(arg.slice('--viewport='.length));
      if (Number.isFinite(n) && n >= 600) args.viewportWidth = Math.round(n);
    } else if (arg.startsWith('--pad=')) {
      const n = Number(arg.slice('--pad='.length));
      if (Number.isFinite(n) && n >= 0 && n <= 100) args.pad = Math.round(n);
    } else {
      args.inputs.push(arg);
    }
  }
  return args;
}

async function waitForPageAssets(page) {
  await page.evaluate(async () => {
    const ready = (async () => {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (e) {}
      }

      const images = Array.from(document.images || []);
      await Promise.all(images.map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      }));
    })();

    // Don't wait forever for a font or image that never finishes loading.
    await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 10000))]);
  });
}

async function addExactColorCSS(page) {
  await page.addStyleTag({
    content: `
      html, body, body * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      html, body {
        background: #ffffff !important;
      }
    `
  });
}

async function pageSize(page) {
  return await page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;

    const width = Math.ceil(Math.max(
      de ? de.scrollWidth : 0,
      de ? de.offsetWidth : 0,
      de ? de.clientWidth : 0,
      body ? body.scrollWidth : 0,
      body ? body.offsetWidth : 0
    ));

    const height = Math.ceil(Math.max(
      de ? de.scrollHeight : 0,
      de ? de.offsetHeight : 0,
      de ? de.clientHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    ));

    return { width: Math.max(width, 1), height: Math.max(height, 1) };
  });
}

async function chartBounds(page, pad, selector) {
  return await page.evaluate((padPx, sel) => {
    let chosen = null;
    if (sel) {
      try { chosen = document.querySelector(sel); } catch (e) { chosen = null; }
    }
    const root =
      chosen ||
      document.querySelector('body > div') ||
      document.body;

    const elements = [root, ...root.querySelectorAll('*')];

    let minLeft = Infinity;
    let minTop = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;

    for (const el of elements) {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      minLeft = Math.min(minLeft, r.left);
      minTop = Math.min(minTop, r.top);
      maxRight = Math.max(maxRight, r.right);
      maxBottom = Math.max(maxBottom, r.bottom);
    }

    if (!Number.isFinite(minLeft) || !Number.isFinite(minTop) ||
        !Number.isFinite(maxRight) || !Number.isFinite(maxBottom)) {
      const r = root.getBoundingClientRect();
      minLeft = r.left;
      minTop = r.top;
      maxRight = r.right;
      maxBottom = r.bottom;
    }

    // Measure in page coordinates so the crop is correct even if the page was scrolled.
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;

    // Clamp the top-left corner to the page edge, then measure width and height from
    // that corner, so padding is never lost on the right or bottom when the left or top
    // edge is clamped.
    const x = Math.max(0, Math.floor(minLeft + sx) - padPx);
    const y = Math.max(0, Math.floor(minTop + sy) - padPx);
    const width = Math.ceil(maxRight + sx) + padPx - x;
    const height = Math.ceil(maxBottom + sy) + padPx - y;

    return {
      x,
      y,
      width: Math.max(width, 1),
      height: Math.max(height, 1),
      matchedSelector: Boolean(chosen)
    };
  }, pad, selector);
}

function outputBase(input) {
  const absolute = path.resolve(input);
  return {
    absolute,
    dir: path.dirname(absolute),
    stem: path.basename(absolute, path.extname(absolute))
  };
}

async function loadLocal(page, input) {
  const { absolute } = outputBase(input);

  if (!fs.existsSync(absolute)) {
    throw new Error(`Input file not found: ${absolute}`);
  }

  // Wait for the page's own load event first. Some pages keep a network connection
  // open (web fonts, analytics, live data), so "network idle" may never happen;
  // in that case wait a short while, then convert what has rendered instead of failing.
  try {
    await page.goto(pathToFileURL(absolute).href, {
      waitUntil: 'load',
      timeout: 60000
    });
  } catch (e) {
    if (!e || e.name !== 'TimeoutError') throw e;
    console.log('Note: the page did not finish loading within 60 seconds; converting what has rendered.');
  }

  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
  } catch (e) {
    console.log('Note: the page kept loading network resources; converting what has rendered after 15 seconds.');
  }

  await waitForPageAssets(page);
  await addExactColorCSS(page);
}

async function convertPdfExact(browser, input, options) {
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: options.viewportWidth,
      height: 1400,
      deviceScaleFactor: 1
    });

    await page.emulateMediaType('screen');
    await loadLocal(page, input);

    const size = await pageSize(page);
    const { dir, stem } = outputBase(input);
    const out = path.join(dir, `${stem}.pdf`);

    await page.pdf({
      path: out,
      width: `${size.width}px`,
      height: `${size.height}px`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
      preferCSSPageSize: false,
      scale: 1
    });

    console.log(`Created: ${out}`);
  } finally {
    await page.close();
  }
}

async function convertPdfLetter(browser, input, options) {
  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: options.viewportWidth,
      height: 1400,
      deviceScaleFactor: 1
    });

    await page.emulateMediaType('screen');
    await loadLocal(page, input);

    const { dir, stem } = outputBase(input);
    const out = path.join(dir, `${stem}_Letter.pdf`);

    await page.pdf({
      path: out,
      format: 'letter',
      landscape: options.landscape,
      margin: {
        top: '0.25in',
        right: '0.25in',
        bottom: '0.25in',
        left: '0.25in'
      },
      printBackground: true,
      preferCSSPageSize: false,
      scale: 1
    });

    console.log(`Created: ${out}`);
  } finally {
    await page.close();
  }
}

async function convertPng(browser, input, options) {
  const page = await browser.newPage();

  try {
    const deviceScaleFactor = options.dpi / 96;

    await page.setViewport({
      width: options.viewportWidth,
      height: 1400,
      deviceScaleFactor
    });

    await page.emulateMediaType('screen');
    await loadLocal(page, input);

    const bounds = await chartBounds(page, options.pad, options.selector);
    if (options.selector && !bounds.matchedSelector) {
      console.log(`Note: no element matched --selector=${options.selector}; cropping to the page content instead.`);
    }
    const clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const { dir, stem } = outputBase(input);
    const out = path.join(dir, `${stem}_${options.dpi}dpi.png`);

    await page.screenshot({
      path: out,
      type: 'png',
      clip,
      captureBeyondViewport: true,
      omitBackground: false
    });

    console.log(`Created: ${out}`);
    console.log(`PNG scale: ${options.dpi} DPI equivalent (${deviceScaleFactor.toFixed(4)}x CSS pixels)`);
    console.log(`Crop padding: ${options.pad}px`);
    console.log(`Captured bounds: ${clip.width} x ${clip.height}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.inputs.length) {
    console.log('');
    console.log('Usage:');
    console.log('  node html2output.mjs --png --dpi=600 [--pad=14] [--selector=CSS] file1.html [file2.html ...]');
    console.log('  node html2output.mjs --pdf-exact file1.html');
    console.log('  node html2output.mjs --pdf-letter --landscape file1.html');
    console.log('');
    process.exit(1);
  }

  const executablePath = findBrowser();

  console.log(`Browser: ${executablePath}`);
  console.log(`Mode: ${options.mode}`);

  // The browser sandbox stays on by default. --no-sandbox is only for environments
  // that cannot run it (for example Linux containers running as root). Only convert
  // HTML files you trust, especially with the sandbox off.
  const launchArgs = ['--allow-file-access-from-files', '--disable-gpu'];
  if (!options.sandbox) launchArgs.push('--no-sandbox');

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: launchArgs
    });
  } catch (err) {
    if (options.sandbox && process.platform === 'linux') {
      console.error('');
      console.error('The browser could not start with its sandbox on. On Linux this usually means');
      console.error('it is running as root or inside a container. If you trust the HTML files,');
      console.error('try again with --no-sandbox.');
    }
    throw err;
  }

  try {
    for (const input of options.inputs) {
      if (options.mode === 'png') {
        await convertPng(browser, input, options);
      } else if (options.mode === 'pdf-letter') {
        await convertPdfLetter(browser, input, options);
      } else {
        await convertPdfExact(browser, input, options);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('');
  console.error('ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
