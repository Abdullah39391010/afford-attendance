import { h, render } from 'preact';
import '../src/shared/styles.css';
import { setupGlass } from '../src/shared/glass.js';
import { setupTyping } from '../src/shared/typing.js';
import { App } from '../src/employee/app.jsx';

// the web version must not use the browser test shortcuts (fake GPS, fake fingerprint)
if (__WEB_APP__) { window.__AFFORD_WEB_APP__ = true; document.documentElement.classList.add('web'); }

setupGlass();
setupTyping();

render(<App />, document.getElementById('app'));
