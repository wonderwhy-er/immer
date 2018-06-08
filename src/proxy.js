"use strict"
// @ts-check

import {
    is,
    has,
    isProxyable,
    isProxy,
    PROXY_STATE,
    TRACKER,
    finalize,
    shallowCopy,
    RETURNED_AND_MODIFIED_ERROR,
    each
} from "./common"

let proxies = null

const objectTraps = {
    get,
    has(target, prop) {
        return prop in source(target)
    },
    ownKeys(target) {
        return Reflect.ownKeys(source(target))
    },
    set,
    deleteProperty,
    getOwnPropertyDescriptor,
    defineProperty,
    setPrototypeOf() {
        throw new Error("Immer does not support `setPrototypeOf()`.")
    }
}

const arrayTraps = {}
each(objectTraps, (key, fn) => {
    arrayTraps[key] = function() {
        arguments[0] = arguments[0][0]
        return fn.apply(this, arguments)
    }
})

function createInitialTracker(base) {
    const tracker = {
        map: new Map(),
        add: (parent, child) => {
            let childBase
            if (isProxy(child)) {
                childBase = child.base
            } else {
                childBase = child
            }

            //TODO may be optimized by implying that if child is proxy then parent is too?
            let parentBase
            if (isProxy(parent)) {
                parentBase = chiparentld.base
            } else {
                parentBase = parent
            }
            if (!tracker.map.has(childBase)) {
                const childInfo = {
                    parents: new Map()
                }
                childInfo.parents.set(parentBase, parentBase)
                tracker.map.set(childBase, childInfo)
            } else {
                tracker.map.get(childBase).parents.set(parentBase, parentBase)
            }
        },
        remove: (parent, child) => {
            let childBase
            if (isProxy(child)) {
                childBase = child.base
            } else {
                childBase = child
            }
            const childInfo = tracker.map.get(childBase)
            childInfo.parents.remove(parent.base)
            if (Array.from(childInfo.parents.entries()).length < 1) {
                tracker.map.remove(childBase)
            }
        },
        registerProxy(proxy) {
            tracker[proxy.base].proxy = proxy
        }
    }

    walk(base, (parent, child) => {
        tracker.add(parent, child)
    })

    return tracker
}

function walk(parent, callback) {
    if (Array.isArray(parent)) {
        parent.forEach(child => {
            if (typeof child === "object") {
                callback(parent, child)
                walk(child, callback)
            }
        })
    } else if (typeof parent === "object") {
        for (let child of Object.values(parent)) {
            if (typeof child === "object") {
                callback(parent, child)
                walk(child, callback)
            }
        }
    }
}

function createState(parent, base) {
    return {
        modified: false,
        finalized: false,
        parent,
        base,
        copy: undefined,
        proxies: {},
        objectTracker: parent
            ? parent.objectTracker
            : createInitialTracker(base)
    }
}

function source(state) {
    return state.modified === true ? state.copy : state.base
}

function get(state, prop) {
    if (prop === PROXY_STATE) return state
    if (state.modified) {
        const value = state.copy[prop]
        if (value === state.base[prop] && isProxyable(value))
            // only create proxy if it is not yet a proxy, and not a new object
            // (new objects don't need proxying, they will be processed in finalize anyway)
            return (state.copy[prop] = createProxy(state, value))
        return value
    } else {
        if (has(state.proxies, prop)) return state.proxies[prop]
        const value = state.base[prop]
        if (!isProxy(value) && isProxyable(value))
            return (state.proxies[prop] = createProxy(state, value))
        return value
    }
}

function set(state, prop, value) {
    if (!state.modified) {
        if (
            (prop in state.base && is(state.base[prop], value)) ||
            (has(state.proxies, prop) && state.proxies[prop] === value)
        )
            return true

        state.objectTracker.add(state, value)
        markChanged(state)
    }
    state.copy[prop] = value
    return true
}

function deleteProperty(state, prop) {
    state.objectTracker.remove(state, state.copy[prop])
    markChanged(state)
    delete state.copy[prop]
    return true
}

function getOwnPropertyDescriptor(state, prop) {
    const owner = state.modified
        ? state.copy
        : has(state.proxies, prop) ? state.proxies : state.base
    const descriptor = Reflect.getOwnPropertyDescriptor(owner, prop)
    if (descriptor && !(Array.isArray(owner) && prop === "length"))
        descriptor.configurable = true
    return descriptor
}

function defineProperty() {
    throw new Error(
        "Immer does not support defining properties on draft objects."
    )
}

function markChanged(state) {
    if (!state.modified) {
        state.modified = true
        state.copy = shallowCopy(state.base)
        // copy the proxies over the base-copy
        Object.assign(state.copy, state.proxies) // yup that works for arrays as well
        if (state.parent) markChanged(state.parent)
    }
}

// creates a proxy for plain objects / arrays
function createProxy(parentState, base) {
    if (isProxy(base)) throw new Error("Immer bug. Plz report.")
    const state = createState(parentState, base)
    const proxy = Array.isArray(base)
        ? Proxy.revocable([state], arrayTraps)
        : Proxy.revocable(state, objectTraps)
    proxies.push(proxy)
    return proxy.proxy
}

export function produceProxy(baseState, producer) {
    if (isProxy(baseState)) {
        // See #100, don't nest producers
        const returnValue = producer.call(baseState, baseState)
        return returnValue === undefined ? baseState : returnValue
    }
    const previousProxies = proxies
    proxies = []
    try {
        // create proxy for root
        const rootProxy = createProxy(undefined, baseState)
        // execute the thunk
        const returnValue = producer.call(rootProxy, rootProxy)
        //console.log("tracker", rootProxy[PROXY_STATE].objectTracker)
        // and finalize the modified proxy
        let result
        // check whether the draft was modified and/or a value was returned
        if (returnValue !== undefined && returnValue !== rootProxy) {
            // something was returned, and it wasn't the proxy itself
            if (rootProxy[PROXY_STATE].modified)
                throw new Error(RETURNED_AND_MODIFIED_ERROR)

            // See #117
            // Should we just throw when returning a proxy which is not the root, but a subset of the original state?
            // Looks like a wrongly modeled reducer
            result = finalize(returnValue)
        } else {
            result = finalize(rootProxy)
        }

        //TODO revoke only modified proxies removing them from tracker as well
        // revoke all proxies
        //each(proxies, (_, p) => p.revoke())

        //result[TRACKER] = rootProxy[PROXY_STATE].objectTracker;

        return result
    } finally {
        proxies = previousProxies
    }
}
