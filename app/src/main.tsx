import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('Falta el elemento #root en index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA: el service worker solo se registra en el build de producción.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // sin service worker la app sigue funcionando, solo no es instalable/offline
    })
  })
}
