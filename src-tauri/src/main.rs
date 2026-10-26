#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

fn main() {
    unsafe {
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    kitsune_lib::run()
}
