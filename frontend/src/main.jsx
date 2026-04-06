import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Amplify } from 'aws-amplify'
import '@aws-amplify/ui-react/styles.css'
import './index.css'
import App from './App.jsx'
import outputs from '../amplify_outputs.json'

const configError = await configureAmplify()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App configError={configError} />
  </StrictMode>,
)

async function configureAmplify() {
  try {
    Amplify.configure(outputs)
    return null
  } catch (error) {
    console.error('Failed to configure Amplify.', error)
    return error instanceof Error ? error.message : 'Amplify の初期化に失敗しました。'
  }
}
