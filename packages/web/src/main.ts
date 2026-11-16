import { createApp } from 'vue'
import App from './App.vue'
import { provideApi, resolveApi } from './api'
import { createAppRouter } from './app/router'
import './styles/base.css'

const app = createApp(App)
const { api, kind } = resolveApi()
provideApi(app, api, kind)
app.use(createAppRouter()).mount('#app')
