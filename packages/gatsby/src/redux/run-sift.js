// @flow
const { default: sift } = require(`sift`)
const _ = require(`lodash`)
const { GraphQLUnionType, GraphQLInterfaceType } = require(`graphql`)
const prepareRegex = require(`../utils/prepare-regex`)
const { makeRe } = require(`micromatch`)
const { getValueAt } = require(`../utils/get-value-at`)

/////////////////////////////////////////////////////////////////////
// Parse filter
/////////////////////////////////////////////////////////////////////

const prepareQueryArgs = (filterFields = {}) =>
  Object.keys(filterFields).reduce((acc, key) => {
    const value = filterFields[key]
    if (_.isPlainObject(value)) {
      acc[key === `elemMatch` ? `$elemMatch` : key] = prepareQueryArgs(value)
    } else {
      switch (key) {
        case `regex`:
          acc[`$regex`] = prepareRegex(value)
          break
        case `glob`:
          acc[`$regex`] = makeRe(value)
          break
        default:
          acc[`$${key}`] = value
      }
    }
    return acc
  }, {})

const getFilters = filters =>
  Object.keys(filters).reduce(
    (acc, key) => acc.push({ [key]: filters[key] }) && acc,
    []
  )

/////////////////////////////////////////////////////////////////////
// Run Sift
/////////////////////////////////////////////////////////////////////

function isEqId(firstOnly, siftArgs) {
  return (
    firstOnly &&
    siftArgs.length > 0 &&
    siftArgs[0].id &&
    Object.keys(siftArgs[0].id).length === 1 &&
    Object.keys(siftArgs[0].id)[0] === `$eq`
  )
}

function handleFirst(siftArgs, nodes) {
  const index = _.isEmpty(siftArgs)
    ? 0
    : nodes.findIndex(
        sift({
          $and: siftArgs,
        })
      )

  if (index !== -1) {
    return [nodes[index]]
  } else {
    return []
  }
}

function handleMany(siftArgs, nodes, sort, resolvedFields) {
  let result = _.isEmpty(siftArgs)
    ? nodes
    : nodes.filter(
        sift({
          $and: siftArgs,
        })
      )

  if (!result || !result.length) return null

  // Sort results.
  if (sort) {
    // create functions that return the item to compare on
    const dottedFields = objectToDottedField(resolvedFields)
    const dottedFieldKeys = Object.keys(dottedFields)
    const sortFields = sort.fields
      .map(field => {
        if (
          dottedFields[field] ||
          dottedFieldKeys.some(key => field.startsWith(key))
        ) {
          return `_$resolved.${field}`
        } else {
          return field
        }
      })
      .map(field => v => getValueAt(v, field))
    const sortOrder = sort.order.map(order => order.toLowerCase())

    result = _.orderBy(result, sortFields, sortOrder)
  }
  return result
}

const toDottedFields = (filter, acc = {}, path = []) => {
  Object.keys(filter).forEach(key => {
    const value = filter[key]
    const nextValue = _.isPlainObject(value) && value[Object.keys(value)[0]]
    if (key === `$elemMatch`) {
      acc[path.join(`.`)] = { [`$elemMatch`]: value }
    } else if (_.isPlainObject(nextValue)) {
      toDottedFields(value, acc, path.concat(key))
    } else {
      acc[path.concat(key).join(`.`)] = value
    }
  })
  return acc
}

const objectToDottedField = (obj, path = []) => {
  let result = {}
  Object.keys(obj).forEach(key => {
    const value = obj[key]
    if (_.isPlainObject(value)) {
      const pathResult = objectToDottedField(value, path.concat(key))
      result = {
        ...result,
        ...pathResult,
      }
    } else {
      result[path.concat(key).join(`.`)] = value
    }
  })
  return result
}

const liftResolvedFields = (args, resolvedFields) => {
  args = toDottedFields(args)
  const dottedFields = objectToDottedField(resolvedFields)
  const dottedFieldKeys = Object.keys(dottedFields)
  const finalArgs = {}
  Object.keys(args).forEach(key => {
    const value = args[key]
    if (dottedFields[key]) {
      finalArgs[`_$resolved.${key}`] = value
    } else if (
      dottedFieldKeys.some(dottedKey => dottedKey.startsWith(key)) &&
      value.$elemMatch
    ) {
      finalArgs[`_$resolved.${key}`] = value
    } else if (dottedFieldKeys.some(dottedKey => key.startsWith(dottedKey))) {
      finalArgs[`_$resolved.${key}`] = value
    } else {
      finalArgs[key] = value
    }
  })
  return finalArgs
}

/**
 * Filters a list of nodes using mongodb-like syntax.
 *
 * @param args raw graphql query filter as an object
 * @param nodes The nodes array to run sift over (Optional
 *   will load itself if not present)
 * @param type gqlType. Created in build-node-types
 * @param firstOnly true if you want to return only the first result
 *   found. This will return a collection of size 1. Not a single
 *   element
 * @returns Collection of results. Collection will be limited to size
 *   if `firstOnly` is true
 */
module.exports = (args: Object) => {
  const { getNode, getNodesAndResolvedNodes } = require(`./nodes`)

  const {
    queryArgs = { filter: {}, sort: {} },
    firstOnly = false,
    resolvedFields = {},
    nodeTypeNames,
  } = args

  let nodes

  if (nodeTypeNames.length > 1) {
    nodes = nodeTypeNames.reduce(
      (acc, typeName) => acc.concat(getNodesAndResolvedNodes(typeName)),
      []
    )
  } else {
    nodes = getNodesAndResolvedNodes(nodeTypeNames[0])
  }

  let siftFilter = getFilters(
    liftResolvedFields(prepareQueryArgs(queryArgs.filter), resolvedFields)
  )

  // If the the query for single node only has a filter for an "id"
  // using "eq" operator, then we'll just grab that ID and return it.
  if (isEqId(firstOnly, siftFilter)) {
    const node = getNode(siftFilter[0].id[`$eq`])

    if (
      !node ||
      (node.internal && !nodeTypeNames.includes(node.internal.type))
    ) {
      return []
    }

    return [node]
  }

  if (firstOnly) {
    return handleFirst(siftFilter, nodes)
  } else {
    return handleMany(siftFilter, nodes, queryArgs.sort, resolvedFields)
  }
}
