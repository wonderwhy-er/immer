"use strict"
const produce = require("./dist/immer").default
const SHALLOW_COPY = require("./dist/immer").SHALLOW_COPY
const trackers = require("./dist/immer").trackers

let state = {
    all: [{value: 1}, {value: 2}, {value: 3}, {value: 4}, {value: 5}],
    selected: []
}
state.selected = [state.all[2], state.all[4]]

let nextState = produce(state, draft => {
    draft.all[2].value = 6
})

function expect(f) {
    let fBody = f.toString().split("=>")[1]
    console.log(`${f() ? "ok" : "fail"}: ${fBody}`)
}

expect(() => state !== nextState)
expect(() => state.all[0] === nextState.all[0])
expect(() => state.all[2] !== nextState.all[2])
expect(() => state.selected[1] === nextState.selected[1])
expect(() => state.selected[0] !== nextState.selected[0])
expect(() => nextState.all[2] === nextState.selected[0])

expect(() => !!trackers.get(nextState))

let nextNextState = produce(nextState, draft => {
    draft.selected[1].value = 7
    draft.selected[0] = draft.all[1]
})

expect(() => nextNextState.all[0] === state.all[0])
expect(() => nextNextState.selected[1] !== state.selected[1])
expect(() => nextNextState.all[4] !== state.all[4])
expect(() => nextNextState.selected[1] !== state.selected[1])
expect(() => nextNextState.all[4] !== nextState.all[4])
expect(() => nextNextState.selected[1] !== nextState.selected[1])
expect(() => nextNextState.selected[0] !== nextState.all[1])
//console.log(nextState[TRACKER])
console.log(nextState)
