package main

import (
	"reflect"
	"testing"
)

func TestZDirCandidates(t *testing.T) {
	const dir = `C:\Users\o\AppData\Local\Programs\Z`
	cases := []struct {
		name                  string
		loc, sw, icon, uninst string
		want                  []string
	}{
		{"what electron-builder writes", "", dir, dir + `\Z.exe,0`, `"` + dir + `\Uninstall Z.exe" /currentuser`, []string{dir}},
		{"no Software key: icon", "", "", dir + `\Z.exe,0`, "", []string{dir}},
		{"uninstaller icon file", "", "", dir + `\uninstallerIcon.ico`, "", []string{dir}},
		{"only the uninstall command", "", "", "", `"` + dir + `\Uninstall Z.exe" /currentuser`, []string{dir}},
		{"unquoted command", "", "", "", dir + `\Uninstall Z.exe /currentuser`, []string{dir}},
		{"quoted icon", "", "", `"` + dir + `\Z.exe",0`, "", []string{dir}},
		{"location first, others kept", `D:\Z\`, "", dir + `\Z.exe,0`, "", []string{`D:\Z`, dir}},
		{"case-insensitive duplicates", dir, `c:\users\o\appdata\local\programs\z`, "", "", []string{dir}},
		{"nothing", "", "", "", "", nil},
		{"broken quote", "", "", "", `"C:\x`, nil},
	}
	for _, c := range cases {
		if got := zDirCandidates(c.loc, c.sw, c.icon, c.uninst); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
