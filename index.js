const fs = require("fs")
const { readFileSync, writeFileSync, existsSync, mkdirSync } = fs
const { join, basename } = require("path")
const glob = require("glob")
const { mkdirp, rimraf } = require("@sveltejs/app-utils/files")

function copyFileSync(source, target) {
    var targetFile = target

    // If target is a directory, a new file with the same name will be created
    if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isDirectory()) {
            targetFile = join(target, basename(source))
        }
    }

    fs.writeFileSync(targetFile, fs.readFileSync(source))
}

function copyFolderRecursiveSync(source, target) {
    var files = []

    // Check if folder needs to be created or integrated
    var targetFolder = join(target, basename(source))
    if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder)
    }

    // Copy
    if (fs.lstatSync(source).isDirectory()) {
        files = fs.readdirSync(source)
        files.forEach(function (file) {
            var curSource = join(source, file)
            if (fs.lstatSync(curSource).isDirectory()) {
                copyFolderRecursiveSync(curSource, targetFolder)
            } else {
                copyFileSync(curSource, targetFolder)
            }
        })
    }
}

/**
 * @param {{
 *   out?: string;
 * }} options
 */
module.exports = function ({ out = "build" } = {}) {
    /** @type {import('@sveltejs/kit').Adapter} */
    const adapter = {
        name: "tomatrow/adapter-shopify",

        async adapt(builder) {
            const prerenderedDir = join(out, "prerendered")
            const themeDir = join(out, "theme")
            const assetsDir = join(themeDir, "assets")
            const appDir = join(out, "_app")

            mkdirp(out)

            copyFolderRecursiveSync("theme", out)
            builder.copy_client_files(out)
            builder.copy_static_files(assetsDir)

            await builder.prerender({
                dest: prerenderedDir,
                force: true
            })

            main({ out })
           
            rimraf(prerenderedDir)
            rimraf(appDir)
        }
    }

    return adapter
}


/** @param {string} part */
function get_parts(part) {
    return part
        .split(/\[(.+?\(.+?\)|.+?)\]/)
        .map((str, i) => {
            if (!str) return null
            const dynamic = i % 2 === 1

            const [, content, qualifier] = dynamic
                ? /([^(]+)(\(.+\))?$/.exec(str)
                : [null, str, null]

            return {
                content,
                dynamic,
                spread: dynamic && /^\.{3}.+$/.test(content),
                qualifier
            }
        })
        .filter(Boolean)
}

/**
 * @param {Part[][]} segments
 * @param {boolean} add_trailing_slash
 */
function get_pattern(segments, add_trailing_slash) {
    const path = segments
        .map(segment => {
            return segment
                .map(part => {
                    return part.dynamic
                        ? part.qualifier || (part.spread ? "(.+)" : "([^/]+?)")
                        : encodeURI(part.content.normalize())
                              .replace(/\?/g, "%3F")
                              .replace(/#/g, "%23")
                              .replace(/%5B/g, "[")
                              .replace(/%5D/g, "]")
                              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                })
                .join("")
        })
        .join("\\/")

    const trailing = add_trailing_slash && segments.length ? "\\/?$" : "$"

    return new RegExp(`^\\/${path}${trailing}`)
}

/** @param {string[]} array */
function get_params(array) {
    // given an array of params like `['x', 'y', 'z']` for
    // src/routes/[x]/[y]/[z]/svelte, create a function
    // that turns a RexExpMatchArray into ({ x, y, z })
    return array.length
        ? "(m) => ({ " +
              array
                  .map((param, i) => {
                      return param.startsWith("...")
                          // todo: figure out what d does 
                          // ? `${param.slice(3)}: d(m[${i + 1}])`
                          // : `${param}: d(m[${i + 1}])`
                          ? `${param.slice(3)}: m[${i + 1}]`
                          : `${param}: m[${i + 1}]`
                  })
                  .join(", ") +
              "})"
        : "empty"
}

const liquidFileByPattern = {
    "account/activate/[id]/[token]": "customers/activate_account.liquid",
    "account/addresses": "customers/addresses.liquid",
    "account/index": "customers/account.liquid",
    "account/login": "customers/login.liquid",
    "account/orders/[handle]": "customers/order.liquid",
    "account/register": "customers/register.liquid",
    "account/reset/[id]/[token]": "customers/reset_password.liquid",
    "blogs/[blog_handle]/[article_handle]": "article.liquid",
    "blogs/[blog_handle]/index": "blog.liquid",
    cart: "cart.liquid",
    "collections/[handle]": "collection.liquid",
    index: "index.liquid",
    "pages/[handle]": "page.liquid",
    "products/[handle]": "product.liquid"
}

function createParamPatterns() {
    return glob.sync("src/routes/**/*", { nodir: true }).map(original => {
        const pattern = original.replace(/src\/routes\/|\.svelte/g, "")
        const parts = get_parts(pattern)
        return {
            original,
            pattern,
            regex: get_pattern([parts], false),
            params: get_params(parts.filter(p => p.dynamic).map(p => p.content))
        }
    })
}

function createFileManifest(out) {
    const appDir = join(out, "_app")
    return glob
        .sync(`${appDir}/**/*`, {
            nodir: true
        })
        .map(from => {
            const pattern = from.replace(appDir + "/pages/", "").replace(/\.svelte.*/, "")
            const asset = from
                .replace(`${out}/`, "")
                // shopify rejects names that start in a bracket, or maybe contain a bracket
                .replace(/[\[\]]/g, "")
                .replaceAll("/", "_")
            return {
                from,
                to: "build/theme/assets/" + asset + ".liquid",
                pattern,
                asset
            }
        })
}

function createPrerenderedManifest(prerenderedDir) {
    return glob
        .sync(`${prerenderedDir}/**/*`, {
            nodir: true
        })
        .map(original => {
            return {
                original,
                path: original
                    .replace(prerenderedDir, "")
                    .replace(".html", "")
                    .replace("/index", "")
            }
        })
}

function main({ out = "build" } = {}) {
    const fileManifest = createFileManifest(out)
    const paramPatterns = createParamPatterns()
    const prerendredManifest = createPrerenderedManifest(join(out, "prerendered"))

    function replaceImports(code) {
        return code.replaceAll(
            /(href=)?"[\-_\.\/a-z\[\]\d]+?\/([\[\]\.\da-z-]+)\.(?:js|css)"/g,
            (_, attribute, baseName) => {
                const asset = fileManifest.find(({ from }) => from.includes(baseName))?.asset
                if (!asset) throw new Error("Unknown asset")
                if (attribute) return `href="{{ '${asset}' | asset_url }}"`
                else return `{{ '${asset}' | asset_url | json }}`
            }
        )
    }

    fileManifest.forEach(({ from, to }) => {
        let code = readFileSync(from, { encoding: "utf8" })
        code = replaceImports(code)
        writeFileSync(to, code)
    })

    paramPatterns
        .map(pp => {
            const to = liquidFileByPattern[pp.pattern]
                ? join("build/theme/templates", liquidFileByPattern[pp.pattern])
                : null
            return {
                ...pp,
                from: prerendredManifest.find(m => m.path.match(pp.regex))?.original,
                to
            }
        })
        .filter(item => item.from && item.to)
        .forEach(item => {
            const iife = `
                (() => {
                    const match = window.location.pathname.match(${item.regex})
                    const make_params = ${item.params}
                    const result = make_params(match)
                    return result === "empty" ? {} : result
                })()
            `

            let code = readFileSync(item.from, { encoding: "utf8" })
            // pathname in the start function
            code = code.replace(/path: .+,/, "path: location.pathname,")
            code = code.replace(/params: .+/, `params: ${iife}`)
            code = code.replace(/<body>.*<\/body>/gs, `<div id="svelte"/>`)
            code = replaceImports(code)
            writeFileSync(item.to, code)
        })
}