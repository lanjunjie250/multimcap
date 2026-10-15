// Run with OFFLINE_URL pointing to the local hand-test fixture (see debug report).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const output = process.env.OFFLINE_REPORT || '/tmp/rtcamera-offline-browser';
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM} : {}), headless:process.env.HEADLESS !== '0',
    args: process.env.HEADLESS === '0' ? ['--ignore-gpu-blocklist','--use-gl=angle','--use-angle=gl'] :
      ['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[], external=[], report={};
  page.on('pageerror', error=>errors.push(error.message));
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if(url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      external.push(url.href);return route.abort();
    }
    return route.continue();
  });
  try {
    await page.goto(process.env.OFFLINE_URL || 'http://127.0.0.1:8093/');
    const image = page.locator('.video-tile canvas:not(.hand-overlay)').first();
    const overlay = page.locator('.hand-overlay').first();
    await page.waitForFunction(()=>document.querySelector('.video-tile canvas')?.dataset.frameKey);
    assert.equal(await page.locator('#hand-enabled').isChecked(), false);
    await page.locator('#hand-enabled').check();
    await page.waitForFunction(()=>document.querySelector('.hand-label')?.textContent === '检测到 1 只手', null, {timeout:60000});
    assert.equal(await overlay.getAttribute('data-frame-key'),await image.getAttribute('data-frame-key'));
    const alpha=await overlay.evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v));
    assert.ok(alpha,'landmarks must actually draw pixels');
    report.initial=await page.locator('#hand-diagnostics').textContent();
    report.decoder=await page.locator('#decode-state').textContent();
    await page.screenshot({path:path.join(output,'hand-overlay.png'),fullPage:true});
    await page.locator('.image-zoom-in').first().click();
    assert.equal(await image.evaluate(c=>c.style.transform),await overlay.evaluate(c=>c.style.transform));
    // Seek to no-hand portion; old landmarks must disappear even before new inference.
    await page.locator('#time-input').fill('00:04.000');
    await page.locator('#time-input').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.hand-label')?.textContent === '未检测到手', null, {timeout:30000});
    assert.equal(await overlay.getAttribute('data-frame-key'),await image.getAttribute('data-frame-key'));
    assert.equal(await overlay.evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v)),false);
    // Reverse seek, then rapid disable/enable while work is in flight.
    await page.locator('#time-input').fill('00:01.000');await page.locator('#time-input').press('Enter');
    await page.locator('#hand-enabled').uncheck();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#hand-state').textContent(),'已关闭');
    assert.equal(await overlay.evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v)),false);
    await page.locator('#hand-enabled').check();
    await page.waitForFunction(()=>!document.querySelector('.hand-label').hidden && document.querySelector('.hand-label').textContent === '检测到 1 只手', null, {timeout:30000});
    await page.locator('#next-frame-button').click();
    await page.waitForFunction(()=>document.querySelector('.hand-overlay').dataset.frameKey === document.querySelector('.video-tile canvas').dataset.frameKey, null, {timeout:30000});
    // Sample every browser render tick: visible overlays may only describe the displayed frame.
    await page.evaluate(()=>{
      window.overlayAudit={shown:0,mismatches:0};
      window.auditTimer=setInterval(()=>{
        for(const tile of document.querySelectorAll('.video-tile'))if(!tile.querySelector('.hand-label').hidden){
          window.overlayAudit.shown++;
          if(tile.querySelector('.hand-overlay').dataset.frameKey!==tile.querySelector('canvas').dataset.frameKey)window.overlayAudit.mismatches++;
        }
      },16);
    });
    await page.locator('#play-button').click();
    await page.waitForTimeout(3500);
    await page.locator('#play-button').click();
    report.audit=await page.evaluate(()=>{clearInterval(window.auditTimer);return window.overlayAudit});
    assert.equal(report.audit.mismatches,0);
    assert.ok(report.audit.shown>0,'playback must show analyzed frames');
    await page.locator('#hand-enabled').uncheck();
    assert.deepEqual(external,[],'offline playback must not require external assets');
    assert.deepEqual(errors,[]);
    // Missing model is visible and cannot break ordinary playback.
    await page.context().route('**/assets/hand_landmarker.task',route=>route.fulfill({status:404,body:'missing'}));
    await page.locator('#hand-enabled').check();
    await page.waitForFunction(()=>document.querySelector('#hand-state').textContent.includes('不可用'),null,{timeout:30000});
    report.missingModel=await page.locator('#hand-state').textContent();
    await page.locator('#hand-enabled').uncheck();
    await page.locator('#prev-frame-button').click();
    report.errors=errors;
    fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
