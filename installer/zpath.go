package main

import "strings"

// zDirCandidates lists the folders Z may be installed in, from what the full installer writes to the registry,
// best first. The Uninstall entry has no InstallLocation (electron-builder writes that one under
// HKCU\Software\<app guid>), so the folders of DisplayIcon and UninstallString back it up. Paths are Windows paths.
func zDirCandidates(uninstallLoc, softwareLoc, displayIcon, uninstallString string) []string {
	var out []string
	add := func(d string) {
		d = strings.TrimRight(strings.TrimSpace(d), `\/`)
		if d == "" {
			return
		}
		for _, o := range out {
			if strings.EqualFold(o, d) {
				return
			}
		}
		out = append(out, d)
	}
	add(uninstallLoc)
	add(softwareLoc)
	add(winDir(exePart(displayIcon, true)))
	add(winDir(exePart(uninstallString, false)))
	return out
}

// exePart takes the file path out of a registry command or icon value:
// `"C:\x\Uninstall Z.exe" /currentuser` → `C:\x\Uninstall Z.exe`, `C:\x\Z.exe,0` → `C:\x\Z.exe`.
func exePart(v string, icon bool) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, `"`) {
		if i := strings.Index(v[1:], `"`); i >= 0 {
			return v[1 : 1+i]
		}
		return ""
	}
	if icon {
		if i := strings.LastIndex(v, ","); i > strings.LastIndexAny(v, `\/`) {
			v = v[:i]
		}
		return v
	}
	if i := strings.Index(strings.ToLower(v), ".exe"); i >= 0 {
		return v[:i+4]
	}
	return ""
}

// winDir is filepath.Dir for a Windows path, on any system; "" when there is no folder part.
func winDir(p string) string {
	i := strings.LastIndexAny(p, `\/`)
	if i <= 0 {
		return ""
	}
	return p[:i]
}
