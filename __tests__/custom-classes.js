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
