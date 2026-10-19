import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { takeToken } from './api.js'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App token={takeToken()} />
  </StrictMode>,
)
