import './index.css';
import { createShellApp } from './shell/switcher';

const rootEl = document.getElementById('root');
if (rootEl) {
  createShellApp(rootEl);
}
