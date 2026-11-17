import { h, render } from 'preact';
import '../src/shared/styles.css';
import { App } from '../src/admin/app.jsx';

render(<App />, document.getElementById('app'));
