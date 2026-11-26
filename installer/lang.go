package main

import "strings"

// pickLang chooses one of Z's five languages from the system's preferred list; anything else is English.
func pickLang(prefs []string) string {
	for _, p := range prefs {
		l := strings.ToLower(p)
		if i := strings.IndexAny(l, "-_"); i >= 0 {
			l = l[:i]
		}
		switch l {
		case "he", "iw":
			return "he"
		case "ar", "es", "ru", "en":
			return l
		}
	}
	return "en"
}
