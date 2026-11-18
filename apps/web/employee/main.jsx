import { h, render } from 'preact';
import '../src/shared/styles.css';
import { App } from '../src/employee/app.jsx';

// the web version must not use the browser test shortcuts (fake GPS, fake fingerprint)
if (__WEB_APP__) window.__AFFORD_WEB_APP__ = true;

render(<App />, document.getElementById('app'));
