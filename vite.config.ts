import { defineConfig } from 'vite'
import path from 'path'
import fs from 'fs'

export default defineConfig(({ mode }) => ({
  define: {
    __LOCAL_TRANSLATION__: JSON.stringify(mode === 'development-local')
  },
  build: {
    lib: {
      entry: {
        'content/content': 'src/content/content.ts',
        'background/background': 'src/background/background.ts'
      },
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]'
      }
    },
    outDir: mode === 'development-local' ? 'dist-local' : 'dist',
    emptyOutDir: true
  },
  plugins: [{
    name: 'isolated-content-entry',
    renderChunk(code, chunk) {
      if (chunk.isEntry && chunk.facadeModuleId?.endsWith('/src/content/content.ts')) {
        // 补注入不产生顶层类声明冲突，后台保留 ES module。
        return { code: `(() => {\n${code}\n})();`, map: null }
      }
    }
  }, {
    name: 'copy-manifest',
    closeBundle() {
      const distDir = path.resolve(__dirname, mode === 'development-local' ? 'dist-local' : 'dist')
      const srcDir = path.resolve(__dirname, 'src')
      const assetsDir = path.resolve(__dirname, 'assets')
      
      // 创建必要的目录
      fs.mkdirSync(path.resolve(distDir, 'content'), { recursive: true })
      fs.mkdirSync(path.resolve(distDir, 'icons'), { recursive: true })
      fs.mkdirSync(path.resolve(distDir, 'popup'), { recursive: true })
      fs.mkdirSync(path.resolve(distDir, 'setup'), { recursive: true })
      fs.mkdirSync(path.resolve(distDir, 'options'), { recursive: true })
      fs.mkdirSync(path.resolve(distDir, 'help'), { recursive: true })
      
      // 复制必需的文件
      const manifest = JSON.parse(fs.readFileSync(path.resolve(srcDir, 'manifest.json'), 'utf8'))
      if (mode === 'development-local') {
        manifest.name = 'LiveTranslate 本地开发'
        manifest.description = '开发构建：初始使用本机火山代理，可在设置中切换服务。'
        manifest.host_permissions = [...(manifest.host_permissions || []), 'http://127.0.0.1/*']
      }
      fs.writeFileSync(path.resolve(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      fs.copyFileSync(
        path.resolve(srcDir, 'content/content.css'),
        path.resolve(distDir, 'content/content.css')
      )
      
      // 复制图标文件
      const iconSizes = ['16', '48', '128']
      iconSizes.forEach(size => {
        const iconFile = `icon-${size}.png`
        const disabledIconFile = `icon-disabled-${size}.png`
        
        // 复制启用图标
        const sourcePath = path.resolve(assetsDir, 'icons', iconFile)
        const targetPath = path.resolve(distDir, 'icons', iconFile)
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath)
        }
        
        // 复制禁用图标
        const disabledSourcePath = path.resolve(assetsDir, 'icons', disabledIconFile)
        const disabledTargetPath = path.resolve(distDir, 'icons', disabledIconFile)
        if (fs.existsSync(disabledSourcePath)) {
          fs.copyFileSync(disabledSourcePath, disabledTargetPath)
        }
      })
      
      // 复制popup文件
      fs.copyFileSync(
        path.resolve(srcDir, 'popup/popup.html'),
        path.resolve(distDir, 'popup/popup.html')
      )
      fs.copyFileSync(
        path.resolve(srcDir, 'popup/popup.js'),
        path.resolve(distDir, 'popup/popup.js')
      )
      for (const filename of ['setup.html', 'setup.js']) {
        fs.copyFileSync(path.resolve(srcDir, 'setup', filename), path.resolve(distDir, 'setup', filename))
      }
      for (const filename of ['options.html', 'options.js']) {
        fs.copyFileSync(path.resolve(srcDir, 'options', filename), path.resolve(distDir, 'options', filename))
      }
      fs.copyFileSync(path.resolve(srcDir, 'help/user-guide.html'), path.resolve(distDir, 'help/user-guide.html'))
      for (const filename of ['privacy-policy.html', 'support.html', 'site.css']) {
        fs.copyFileSync(path.resolve(__dirname, 'docs/web-store', filename), path.resolve(distDir, 'help', filename))
      }
      
      console.log(`✅ 扩展已构建到 ${distDir}`)
    }
  }]
}))
