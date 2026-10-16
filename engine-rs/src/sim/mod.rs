//! The design simulator (src/sim): the component catalogue's numbers and the fluid engine.

pub mod audit;
pub mod availability;
pub mod catalog;
pub mod des;
pub mod engine;
pub mod headless;
pub mod optimize;
pub mod spec;
pub mod journey;
pub mod trace;

#[cfg(test)]
mod trace_tests;
