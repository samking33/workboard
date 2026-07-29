// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package files

import (
	"io"
	"mime"
	"net/http"
	"strconv"

	"code.vikunja.io/api/pkg/files"
)

// WriteFileDownload streams a loaded file (its .File reader must be open) to the
// response as an attachment download: http.ServeContent for seekable local files
// (Range + If-Modified-Since for free), a manual 304 + io.Copy otherwise. It does
// not close the reader; the caller owns it.
// WriteFilePreview serves a file inline so the browser can render it in place.
//
// The real protection is the caller's mime allowlist: bytes we refuse never
// reach this function, so an uploaded .html is never rendered as a document on
// our origin. The CSP here only covers direct navigation to this endpoint — the
// web client fetches the body over XHR and renders it from a blob URL, and
// response headers do not follow a blob. Do not treat it as a substitute for
// the allowlist.
func WriteFilePreview(w http.ResponseWriter, r *http.Request, f *files.File) {
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("Content-Disposition",
		mime.FormatMediaType("inline", map[string]string{"filename": f.Name}))
	writeFile(w, r, f)
}

func WriteFileDownload(w http.ResponseWriter, r *http.Request, f *files.File) {
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	writeFile(w, r, f)
}

// writeFile emits the body and the headers common to inline and attachment
// responses. The caller owns Content-Disposition.
func writeFile(w http.ResponseWriter, r *http.Request, f *files.File) {
	// Downloads must never be cached. no-cache overrides the global no-store
	// directive so revalidation (If-Modified-Since) still works.
	w.Header().Set("Cache-Control", "no-cache")

	mimeToReturn := f.Mime
	if mimeToReturn == "" {
		mimeToReturn = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mimeToReturn)
	// Never let the browser sniff a type other than the one we detected.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatUint(f.Size, 10))
	w.Header().Set("Last-Modified", f.Created.UTC().Format(http.TimeFormat))

	// Local files are *os.File (seekable), so ServeContent gives Range +
	// If-Modified-Since for free; s3 (and the in-memory test storage) return a
	// non-seekable reader, so check If-Modified-Since manually and io.Copy.
	if seeker, ok := f.File.(io.ReadSeeker); ok {
		http.ServeContent(w, r, f.Name, f.Created, seeker)
		return
	}

	if ifModSince := r.Header.Get("If-Modified-Since"); ifModSince != "" {
		if t, parseErr := http.ParseTime(ifModSince); parseErr == nil && !f.Created.UTC().After(t) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	_, _ = io.Copy(w, f.File)
}
