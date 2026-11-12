import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './settings-interactions.css'
import { LanguageProvider } from './lib/i18n'
import { ThemeProvider } from 'twenty-ui/theme'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider colorScheme="light" applyToRoot>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
