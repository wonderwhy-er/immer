"use strict"
// @ts-check

import {
    is,
    has,
    isProxyable,
    isProxy,
    PROXY_STATE,
    finalize,
    shallowCopy,
    RETURNED_AND_MODIFIED_ERROR,
    each,
    trackers
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
        add: (parent, key, child) => {
            let childBase
            if (isProxy(child)) {
                childBase = child.base
            } else {
                childBase = child
            }

            let parentBase
            if (isProxy(parent)) {
                parentBase = parent.base
            } else {
                parentBase = parent
            }

            let childInfo = tracker.map.get(childBase)
            if (!childInfo) {
                childInfo = {
                    parents: new Map()
                }
                tracker.map.set(childBase, childInfo)
            }

            if (parentBase) {
                let parentKeys = childInfo.parents.get(parentBase)
                if (!parentKeys) {
                    parentKeys = {}
                    childInfo.parents.set(parentBase, parentKeys)
                }
                parentKeys[key] = key
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
        registerStateAndProxy(state, proxy) {
            const childInfo = tracker.map.get(state.base)
            childInfo.proxy = proxy
            childInfo.state = state
        },
        getProxy(base) {
            return tracker.map.get(base).proxy
        },
        getState(base) {
            return tracker.map.get(base).state
        }
    }

    walk(base, (parent, key, child) => {
        tracker.add(parent, key, child)
    })

    return tracker
}

//TODO add objects on add hook
//TODO remove objects when removed
//TODO if object switched then remove and add
//TODO it seems that tracker stays in finalized objects for non root, may be we need to remove tracker from non root elements?
//TODO fix tests
//TODO check performance

function walk(parent, callback) {
    if (Array.isArray(parent)) {
        parent.forEach((child, index) => {
            if (typeof child === "object") {
                callback(parent, index, child)
                walk(child, callback)
            }
        })
    } else if (typeof parent === "object") {
        for (let [key, child] of Object.entries(parent)) {
            if (typeof child === "object") {
                callback(parent, key, child)
                walk(child, callback)
            }
        }
    }
}

function createState(parent, base) {
    const state = {
        modified: false,
        finalized: false,
        parent,
        base,
        copy: undefined,
        proxies: {},
        //TODO optimize? can we move this somewhere passing fake parent initially with createInitialTracker for example
        objectTracker: parent
            ? parent.objectTracker
            : trackers.get(base) || createInitialTracker(base)
    }

    if (!parent) {
        state.objectTracker.add(undefined, undefined, base)
    }

    return state
}

function source(state) {
    return state.modified === true ? state.copy : state.base
}

//TODO apperantly is inneficient as this gonna be visited multiple times for same base
function proxyfyParents(tracker, base, parentException) {
    const info = tracker.map.get(base)

    for (let [parentBase, keys] of info.parents.entries()) {
        const parentInfo = tracker.map.get(parentBase)
        if (!parentInfo.proxy) {
            proxyfyParents(tracker, parentBase)
        }
        Object.values(keys).forEach(key => parentInfo.proxy[key])
    }
}

function switchToProxy(parentState, targetForProxy, prop, value) {
    const proxy =
        parentState.objectTracker.getProxy(value) ||
        createProxy(parentState, value)

    targetForProxy[prop] = proxy

    proxyfyParents(parentState.objectTracker, value, parentState.base)
    return proxy
}

function get(state, prop) {
    if (prop === PROXY_STATE) return state
    if (state.modified) {
        const value = state.copy[prop]
        if (value === state.base[prop] && isProxyable(value)) {
            // only create proxy if it is not yet a proxy, and not a new object
            // (new objects don't need proxying, they will be processed in finalize anyway)
            return switchToProxy(state, state.copy, prop, value)
        }
        return value
    } else {
        if (has(state.proxies, prop)) return state.proxies[prop]
        const value = state.base[prop]
        if (!isProxy(value) && isProxyable(value)) {
            return switchToProxy(state, state.proxies, prop, value)
        }

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

        state.objectTracker.add(state, prop, value)
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

        //TODO mark all parent changes state.objectTracker.get(state.base).parents
        for (let [parentBase, keys] of state.objectTracker.map
            .get(state.base)
            .parents.entries()) {
            markChanged(state.objectTracker.getState(parentBase))
        }
    }
}

// creates a proxy for plain objects / arrays
function createProxy(parentState, base) {
    if (isProxy(base)) throw new Error("Immer bug. Plz report.")
    const state = createState(parentState, base)
    const proxy = Array.isArray(base)
        ? Proxy.revocable([state], arrayTraps)
        : Proxy.revocable(state, objectTraps)
    state.objectTracker.registerStateAndProxy(state, proxy.proxy)
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

        return result
    } finally {
        proxies = previousProxies
    }
}
