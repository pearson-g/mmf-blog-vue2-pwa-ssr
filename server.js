/**
 * @file render server
 * @author lincenying(lincenying@qq.com)
 */
var jwt = require('jsonwebtoken')
var config = require('./server/config')
var secret = config.secretServer

const logger = require('morgan')
const cookieParser = require('cookie-parser')
const bodyParser = require('body-parser')
// 引入 mongoose 相关模型
require('./server/models/admin')
require('./server/models/article')
require('./server/models/category')
require('./server/models/comment')
require('./server/models/like')
require('./server/models/user')
// 引入 api 路由
const routes = require('./server/routes/index')

const fs = require('fs')
const path = require('path')
const lurCache = require('lru-cache')
const express = require('express')
const favicon = require('serve-favicon')
const compression = require('compression')
const resolve = file => path.resolve(__dirname, file)
const vueServerRenderer = require('vue-server-renderer')
const createBundleRenderer = vueServerRenderer.createBundleRenderer

const isProd = process.env.NODE_ENV === 'production'
const useMicroCache = process.env.MICRO_CACHE !== 'false'
const serverInfo = ''
    + 'express/' + require('express/package.json').version
    + 'vue-server-renderer/' + require('vue-server-renderer/package.json').version

const app = express()

const template = fs.readFileSync(resolve('./src/template/index.template.html'), 'utf-8')

function createRenderer(bundle, options) {

    // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
    return createBundleRenderer(bundle, Object.assign(options, {
        template,

        // for component caching
        cache: lurCache({
            max: 1000,
            maxAge: 1000 * 60 * 15
        }),

        // this is only needed when vue-server-renderer is npm-linked
        basedir: resolve('./dist'),

        // recommended for performance
        runInNewContext: false
    }))
}

let renderer
let readyPromise

if (isProd) {

    // In production: create server renderer using built server bundle.
    // The server bundle is generated by vue-ssr-webpack-plugin.
    const bundle = require('./dist/vue-ssr-server-bundle.json')

    // The client manifests are optional, but it allows the renderer
    // to automatically infer preload/prefetch links and directly add <script>
    // tags for any async chunks used during render, avoiding waterfall requests.
    const clientManifest = require('./dist/vue-ssr-client-manifest.json')

    renderer = createRenderer(bundle, {
        clientManifest
    })
}
else {

    // In development: setup the dev server with watch and hot-reload,
    // and create a new renderer on bundle / index template update.
    readyPromise = require('./build/setup-dev-server')(app, (bundle, options) => {
        renderer = createRenderer(bundle, options)
    })
}

const serve = (path, cache) => express.static(resolve(path), {
    maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0
})


// 引用 esj 模板引擎
app.set('views', path.join(__dirname, 'dist'))
app.engine('.html', require('ejs').__express)
app.set('view engine', 'ejs')

app.use(compression({threshold: 0}))

// 日志
app.use(logger('":method :url" :status :res[content-length] ":referrer" ":user-agent"'))
// body 解析中间件
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
// cookie 解析中间件
app.use(cookieParser())
// 设置 express 根目录

app.use(express.static(path.join(__dirname, 'dist')))
app.use('/static', serve('./dist/static', true))
app.use(favicon('./static/img/icons/favicon-32x32.png'))
// app.use('/static', serve('./static', true));
app.use('/dist', serve('./dist', true))
app.use('/manifest.json', serve('./manifest.json', true))
app.use('/service-worker.js', serve('./dist/service-worker.js'))
// api 路由
app.use('/api', routes)

// 1-second microcache.
// https://www.nginx.com/blog/benefits-of-microcaching-nginx/
const microCache = lurCache({
    max: 100,
    maxAge: 1000
})

// since this app has no user-specific content, every page is micro-cacheable.
// if your app involves user-specific content, you need to implement custom
// logic to determine whether a request is cacheable based on its url and
// headers.
const isCacheable = () => useMicroCache

const checkAdminToken = (req, res) => {
    var token = req.cookies.b_user,
        userid = req.cookies.b_userid,
        username = req.cookies.b_username
    if (token) {
        return new Promise(resolve => {
            jwt.verify(token, secret, function(err, decoded) {
                if (!err && decoded.id === userid && (decoded.username === username || decoded.username === encodeURI(username))) {
                    req.decoded = decoded
                    resolve(true)
                } else {
                    res.cookie('b_user', '', { maxAge: 0 })
                    res.cookie('b_userid', '', { maxAge: 0 })
                    res.cookie('b_username', '', { maxAge: 0 })
                    resolve(false)
                }
            })
        })
    }
    return false
}

const checkUserToken = (req, res) => {
    var token = req.cookies.user,
        userid = req.cookies.userid,
        username = req.cookies.username
    if (token) {
        return new Promise(resolve => {
            jwt.verify(token, secret, function(err, decoded) {
                if (!err && decoded.id === userid && (decoded.username === username || decoded.username === encodeURI(username))) {
                    req.decoded = decoded
                    resolve('')
                } else {
                    res.cookie('user', '', { maxAge: 0 })
                    res.cookie('userid', '', { maxAge: 0 })
                    res.cookie('username', '', { maxAge: 0 })
                    resolve('/')
                }
            })
        })
    }
    return '/'
}

const checkAdmin = (req, res) => {
    if (req.url === '/backend' || req.url === '/backend/') {
        return checkAdminToken(req, res) ? '/backend/article/list' : ''
    } else if (req.url.indexOf('/backend/') > -1) {
        return checkAdminToken(req, res) ? '' : '/backend'
    } else if (req.url.indexOf('/user/') > -1) {
        return checkUserToken(req, res)
    }
    return ''
}

function render(req, res) {
    const backUrl = checkAdmin(req, res)
    if (backUrl) {
        return res.redirect(backUrl)
    }

    const s = Date.now()
    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Server', serverInfo)

    const handleError = err => {
        if (err.url) {
            res.redirect(err.url)
        } else if (err.code === 404) {
            res.status(404).end('404 | Page Not Found')
        } else {

            // Render Error Page or Redirect
            res.status(500).end('500 | Internal Server Error')
            console.error(`error during render : ${req.url}`)
            console.error(err.stack)
        }
    }

    const cacheable = isCacheable(req)

    if (cacheable) {
        const hit = microCache.get(req.url)

        if (hit) {
            if (!isProd) {
                console.log('cache hit!')
            }
            return res.end(hit)
        }
    }
    const context = {
        // default title
        title: 'M.M.F 小屋',
        url: req.url,
        cookies: req.cookies,
    }
    renderer.renderToString(context, (err, html) => {
        if (err) {
            return handleError(err)
        }
        res.end(html)
        if (cacheable) {
            microCache.set(req.url, html)
        }
        if (!isProd) {
            console.log(`whole request: ${Date.now() - s}ms`)
        }
    })
}

app.get('*', isProd ? render : (req, res) => {
    readyPromise.then(() => render(req, res))
})

const port = process.env.PORT || 8080
app.listen(port, () => {
    console.log('server started at localhost:' + port)
})
