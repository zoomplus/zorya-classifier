function resolveBinding(context, node) {
  let scope = context.sourceCode.getScope(node)
  while (scope) {
    const variable = scope.set.get(node.name)
    if (variable) return variable
    scope = scope.upper
  }
  return undefined
}
function globalBinding(context, node) {
  return (resolveBinding(context, node)?.defs.length ?? 0) === 0
}
function nodeTimerBinding(context, node, imported) {
  return (
    resolveBinding(context, node)?.defs.some(
      (definition) =>
        definition.type === 'ImportBinding' &&
        ['node:timers', 'timers'].includes(definition.parent?.source.value) &&
        (imported === '*'
          ? definition.node.type === 'ImportNamespaceSpecifier'
          : definition.node.type === 'ImportSpecifier' &&
            definition.node.imported.name === imported),
    ) ?? false
  )
}

function isGlobalInterval(context, callee) {
  if (callee.type === 'Identifier')
    return (
      (callee.name === 'setInterval' && globalBinding(context, callee)) ||
      nodeTimerBinding(context, callee, 'setInterval')
    )
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) return false
  const { object, property } = callee
  return (
    object.type === 'Identifier' &&
    ((['globalThis', 'window', 'global'].includes(object.name) && globalBinding(context, object)) ||
      nodeTimerBinding(context, object, '*')) &&
    property.type === 'Identifier' &&
    property.name === 'setInterval'
  )
}

export const noDiscardedInterval = {
  meta: {
    type: 'problem',
    docs: { description: 'Retain a global interval handle for its resource owner to clear.' },
    schema: [],
    messages: { discarded: 'Retain the setInterval handle and clear it when its owner stops.' },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isGlobalInterval(context, node.callee)) return
        const parent = node.parent
        const discarded =
          parent.type === 'ExpressionStatement' ||
          (parent.type === 'UnaryExpression' && parent.operator === 'void')
        if (discarded) context.report({ node, messageId: 'discarded' })
      },
    }
  },
}
