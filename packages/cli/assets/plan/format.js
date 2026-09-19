/**
 * The plan page's sentence formatter. A dictionary value is a template, and the
 * template decides the order: `a {actor} calls {route}` and `{actor} が {route} を呼ぶ`
 * take the same values. A value is only ever text or a node, never a template, so a
 * plan string spelling `{route}` is written out as those seven characters.
 */
function walkTemplate(template, values, onText, onNode) {
  var pattern = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g
  var last = 0
  var match
  while ((match = pattern.exec(template)) !== null) {
    if (match.index > last) onText(template.slice(last, match.index))
    var known = values !== undefined && values !== null && Object.prototype.hasOwnProperty.call(values, match[1])
    var value = known ? values[match[1]] : undefined
    // An unknown placeholder stays on the page as written: a blank would read as a
    // finished sentence with a word missing.
    if (value === undefined || value === null) onText(match[0])
    else if (typeof value === 'object' && value.nodeType) onNode(value)
    else onText(String(value))
    last = pattern.lastIndex
  }
  if (last < template.length) onText(template.slice(last))
}

function formatInto(host, template, values) {
  walkTemplate(
    template,
    values,
    function (text) {
      host.appendChild(document.createTextNode(text))
    },
    function (node) {
      host.appendChild(node)
    },
  )
  return host
}

/** For the places that take a string: an attribute, an `option`, a placeholder. */
function formatText(template, values) {
  var out = ''
  walkTemplate(
    template,
    values,
    function (text) {
      out += text
    },
    function (node) {
      out += node.textContent
    },
  )
  return out
}
