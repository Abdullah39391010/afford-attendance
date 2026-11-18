import { h, render } from 'preact';
import '../src/shared/styles.css';
import { App } from '../src/admin/app.jsx';

if (__WEB_APP__) { window.__AFFORD_WEB_APP__ = true; document.documentElement.classList.add('web'); }

render(<App />, document.getElementById('app'));
