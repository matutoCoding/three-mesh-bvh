// Temporary performance check for example/sculpt.js — not part of the repo.
// Starts the vite dev server, loads sculpt.html?faces=2000000, simulates a
// brush drag, and reports the stats panel contents + webgl renderer info.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const WORKSPACE = fileURLToPath( new URL( '.', import.meta.url ) );
const PORT = 5199;

function waitFor( ms ) {

	return new Promise( r => setTimeout( r, ms ) );

}

const vite = spawn(
	'npx',
	[ 'vite', '--config', './vite.config.js', '--port', String( PORT ), '--strictPort' ],
	{ cwd: WORKSPACE, shell: true, stdio: [ 'ignore', 'pipe', 'pipe' ] },
);

let serverUp = false;
vite.stdout.on( 'data', d => process.stderr.write( d ) );
vite.stderr.on( 'data', d => process.stderr.write( d ) );

const start = Date.now();
while ( ! serverUp && Date.now() - start < 60000 ) {

	try {

		const res = await fetch( `http://localhost:${ PORT }/sculpt.html` );
		if ( res.ok ) serverUp = true;

	} catch {

		// not up yet

	}

	if ( ! serverUp ) await waitFor( 500 );

}

if ( ! serverUp ) {

	console.error( 'vite dev server did not start' );
	vite.kill();
	process.exit( 1 );

}

let browser;
try {

	browser = await puppeteer.launch( {
		headless: true,
		args: [
			'--enable-gpu',
			'--use-angle=default',
			'--enable-unsafe-swiftshader',
			'--window-size=1280,800',
		],
	} );

	const page = await browser.newPage();
	await page.setViewport( { width: 1280, height: 800 } );
	page.on( 'pageerror', e => console.error( 'PAGE ERROR:', e.message ) );
	page.on( 'console', m => {

		if ( m.type() === 'error' || m.type() === 'warning' ) {

			console.log( 'CONSOLE', m.type(), m.text() );

		}

	} );

	console.log( 'loading page (2M faces, BVH build takes a moment)...' );
	await page.goto( `http://localhost:${ PORT }/sculpt.html?faces=2000000`, {
		waitUntil: 'load',
		timeout: 60000,
	} );

	// wait until the stats panel reports the tri count (means render loop runs)
	await page.waitForFunction(
		() => {
			const el = document.querySelector( '#sculpt-stats' );
			return el && /tris/.test( el.textContent );
		},
		{ timeout: 180000, polling: 500 },
	);
	console.log( 'scene ready:', await page.$eval( '#sculpt-stats', el => el.textContent ) );

	const gl = await page.evaluate( () => {

		const c = document.createElement( 'canvas' );
		const g = c.getContext( 'webgl2' );
		const info = g.getExtension( 'WEBGL_debug_renderer_info' );
		return info ? g.getParameter( info.UNMASKED_RENDERER_WEBGL ) : 'unknown';

	} );
	console.log( 'WebGL renderer:', gl );

	// let it settle a few frames
	await waitFor( 1500 );
	console.log( 'idle:', await page.$eval( '#sculpt-stats', el => el.textContent ) );

	// simulate a brush drag across the model
	await page.mouse.move( 640, 400 );
	await waitFor( 100 );
	await page.mouse.down();
	const samples = [];
	for ( let i = 0; i < 90; i ++ ) {

		const a = i * 0.15;
		await page.mouse.move( 640 + 150 * Math.cos( a ), 400 + 120 * Math.sin( a ) );
		await waitFor( 16 );
		if ( i % 15 === 0 ) {

			samples.push( await page.$eval( '#sculpt-stats', el => el.textContent ) );

		}

	}

	await page.mouse.up();
	await waitFor( 500 );
	samples.push( await page.$eval( '#sculpt-stats', el => el.textContent ) );

	console.log( '\nwhile dragging:' );
	samples.forEach( s => console.log( ' ', s ) );

	// undo / redo smoke test via keyboard
	await page.keyboard.down( 'Control' );
	await page.keyboard.press( 'z' );
	await page.keyboard.up( 'Control' );
	await waitFor( 500 );
	console.log( 'after ctrl+z:', await page.$eval( '#sculpt-stats', el => el.textContent ) );

} finally {

	if ( browser ) await browser.close();
	vite.kill();

}
