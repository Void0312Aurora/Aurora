import * as yaml from 'js-yaml'

const metadataFields = ['id', 'name', 'group', 'disabled', 'inject', 'intercept', 'isolate']

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data) => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})

const schema = yaml.JSON_SCHEMA.extend(jsExprType)

/** Parse one Cordis Loader YAML document while retaining `!!js` expressions. */
export function parseLoaderConfig(text) {
  return yaml.load(text, { schema })
}

/**
 * Find expression objects in Loader metadata. Loader interpolates only
 * `config`, so any expression found here would remain truthy data at runtime.
 */
export function validateLoaderMetadata(document, file) {
  const errors = []
  if (!Array.isArray(document)) return errors
  for (let index = 0; index < document.length; index++) {
    validateEntry(document[index], file, `[${String(index)}]`, errors)
  }
  return errors
}

function validateEntry(value, file, path, errors) {
  if (!isRecord(value)) return
  validateMetadata(value, file, path, errors)
  if ((value.group === true || value.name === '@cordisjs/plugin-group') && Array.isArray(value.config)) {
    for (let index = 0; index < value.config.length; index++) {
      validateEntry(value.config[index], file, `${path}.config[${String(index)}]`, errors)
    }
  }
  if (Array.isArray(value.insert)) {
    for (let index = 0; index < value.insert.length; index++) {
      validateEntry(value.insert[index], file, `${path}.insert[${String(index)}]`, errors)
    }
  }
  if (value.name !== '@cordisjs/plugin-include' || !isRecord(value.config) || !Array.isArray(value.config.patches)) return
  for (let index = 0; index < value.config.patches.length; index++) {
    const patch = value.config.patches[index]
    const patchPath = `${path}.config.patches[${String(index)}]`
    if (!isRecord(patch)) continue
    validateMetadata(patch, file, patchPath, errors)
    if (!Array.isArray(patch.insert)) continue
    for (let insertIndex = 0; insertIndex < patch.insert.length; insertIndex++) {
      validateEntry(patch.insert[insertIndex], file, `${patchPath}.insert[${String(insertIndex)}]`, errors)
    }
  }
}

function validateMetadata(entry, file, path, errors) {
  for (const field of metadataFields) {
    if (!(field in entry)) continue
    const expressionPaths = []
    collectExpressionPaths(entry[field], `${path}.${field}`, expressionPaths)
    for (const expressionPath of expressionPaths) {
      errors.push(`${file}${expressionPath}: !!js is not interpolated here`)
    }
  }
}

function collectExpressionPaths(value, path, output) {
  if (isJsExpr(value)) {
    output.push(path)
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      collectExpressionPaths(value[index], `${path}[${String(index)}]`, output)
    }
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) collectExpressionPaths(child, `${path}.${key}`, output)
}

function isJsExpr(value) {
  return isRecord(value) && typeof value.__jsExpr === 'string'
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
