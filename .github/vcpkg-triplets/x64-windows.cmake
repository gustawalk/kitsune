set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE dynamic)
# Only release DLLs are shipped and used by Rust's dynamic adapters.
set(VCPKG_BUILD_TYPE release)
