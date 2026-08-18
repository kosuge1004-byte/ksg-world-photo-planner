import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initializePwaInstallSupport } from './pwa/install'

initializePwaInstallSupport()

createRoot(document.getElementById('root')!).render(
  <App />
)
