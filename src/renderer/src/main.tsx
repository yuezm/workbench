import React from 'react'
import ReactDOM from 'react-dom/client'
import { Workbench } from './shell/Workbench'
import './shell/styles/global.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Workbench />
  </React.StrictMode>
)
