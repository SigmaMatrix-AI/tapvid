// Template transition extension slot. A template that needs a transition type the built-in
// library lacks ships template/transitions.js exporting `extraTransitions`; the project build
// copies it over this file. Each entry is (progress, params) => { outgoing, incoming, incomingOnTop }.
export const extraTransitions = {};
