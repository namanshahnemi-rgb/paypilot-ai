import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { productionApiUrlProblem } from './src/apiConfig.ts'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // A production bundle without the backend URL would call
  // http://localhost:4000 from users' browsers, so refuse to build it.
  if (command === 'build' && mode === 'production') {
    const problem = productionApiUrlProblem(loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL)
    if (problem) {
      throw new Error(
        `${problem}. Set VITE_API_URL=https://<backend host> in client/.env.production ` +
          '(saved as UTF-8 without a BOM, or Vite ignores the first line) or as an ' +
          'environment variable in the build environment.',
      )
    }
  }
  return { plugins: [react()] }
})
