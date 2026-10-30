import React from 'react';
import {createRoot} from 'react-dom/client';
import {LanguageProvider} from '../../src/lib/i18n';
import '../../src/index.css';
import '../../src/codex-theme.css';
import '../../src/settings-interactions.css';
import '../../src/flearning-theme.css';
// Match the real App ancestor while allowing explicit light/dark regression scenarios.
export function mountFixture(children){
 const theme=new URLSearchParams(location.search).get('theme')||'light';
 document.body.classList.remove('codex-dark','writer-light');
 document.body.classList.add(theme==='dark'?'codex-dark':'writer-light');
 createRoot(document.getElementById('root')).render(<LanguageProvider>{children}</LanguageProvider>);
}
