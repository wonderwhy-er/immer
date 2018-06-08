"use strict"
import produce, {SHALLOW_COPY} from "../src/immer"

class Task {
    constructor(_name, _state) {
        this.name = _name
        this.state = _state
        this[SHALLOW_COPY] = () => {
            return new Task(this.name, this.state)
        }
    }

    check() {
        this.state = true
    }

    uncheck() {
        this.state = false
    }
}

describe("support for custom classes", () => {
    it("should understand custom classes inside the tree", () => {
        let baseState = [new Task("test", false), new Task("test 2", true)]

        let nextState = produce(baseState, draft => {
            draft[0].check()
            draft.push(new Task("test 3", false))
        })

        expect(nextState).not.toBe(baseState)
        expect(nextState[0]).not.toBe(baseState[0])
        expect(nextState[1]).toBe(baseState[1])
        expect(nextState[0].constructor.name).toBe("Task")
    })
})

describe("cyclic structure test", () => {
    it("should understand cyclic structure", () => {
        let start = {
            items: [
                {
                    value: 1
                },
                {
                    value: 2
                },
                {
                    value: 3
                },
                {
                    value: 4
                }
            ],
            lists: []
        }

        start.lists.push([start.items[0]])
        start.lists.push([start.items[1]])

        let nextState = produce(start, draft => {
            draft.items[0].value = 5
        })

        expect(nextState).not.toBe(start)
        expect(start.items[0].value).toEqual(start.lists[0][0].value)
        expect(start.lists[1]).toBe(nextState.lists[1])
        expect(start.lists[0]).not.toBe(nextState.lists[0])

        expect(nextState.items[0]).toBe(nextState.lists[0][0])
        expect(nextState.items[0].value).toEqual(nextState.lists[0][0].value)
    })
})
