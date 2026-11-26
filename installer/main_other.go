//go:build !windows

package main

import (
	"fmt"
	"os"
)

// Z Setup is a Windows program. On other systems it only exists so the flow can be tested.
func main() {
	fmt.Fprintln(os.Stderr, "Z Setup runs on Windows. On Mac use the DMG, on Linux the AppImage or DEB.")
	os.Exit(2)
}
