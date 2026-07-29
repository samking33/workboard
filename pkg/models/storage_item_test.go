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

package models

import (
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// owner has access to project 1; stranger has none.
var (
	storageOwner    = &user.User{ID: 1}
	storageStranger = &user.User{ID: 2}
)

func TestStorageItem_Permissions(t *testing.T) {
	t.Run("CanRead", func(t *testing.T) {
		t.Run("owner", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ID: 1, ProjectID: 1}
			can, _, err := si.CanRead(s, storageOwner)
			require.NoError(t, err)
			assert.True(t, can)
		})
		t.Run("stranger", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ID: 1, ProjectID: 1}
			can, _, err := si.CanRead(s, storageStranger)
			require.NoError(t, err)
			assert.False(t, can)
		})
	})

	t.Run("CanCreate", func(t *testing.T) {
		t.Run("owner", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ProjectID: 1}
			can, err := si.CanCreate(s, storageOwner)
			require.NoError(t, err)
			assert.True(t, can)
		})
		t.Run("stranger", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ProjectID: 1}
			can, err := si.CanCreate(s, storageStranger)
			require.NoError(t, err)
			assert.False(t, can)
		})
	})

	t.Run("CanUpdate", func(t *testing.T) {
		t.Run("owner", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ID: 1, ProjectID: 1, Title: "renamed"}
			can, err := si.CanUpdate(s, storageOwner)
			require.NoError(t, err)
			assert.True(t, can)
			assert.Equal(t, "renamed", si.Title, "the caller's new title must survive the permission load")
		})
		t.Run("stranger", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ID: 1, ProjectID: 1, Title: "renamed"}
			can, err := si.CanUpdate(s, storageStranger)
			require.NoError(t, err)
			assert.False(t, can)
		})
	})

	t.Run("CanDelete", func(t *testing.T) {
		t.Run("owner", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ID: 1, ProjectID: 1}
			can, err := si.CanDelete(s, storageOwner)
			require.NoError(t, err)
			assert.True(t, can)
		})
		t.Run("stranger", func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()

			si := &StorageItem{ID: 1, ProjectID: 1}
			can, err := si.CanDelete(s, storageStranger)
			require.NoError(t, err)
			assert.False(t, can)
		})
	})

	// Item 1 lives in project 1. Asking for it through a project the caller can
	// reach must not expose it.
	t.Run("item from another project is not reachable", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ID: 3, ProjectID: 1}
		_, _, err := si.CanRead(s, storageOwner)
		require.Error(t, err)
		assert.True(t, IsErrStorageItemDoesNotExist(err))
	})

	t.Run("nonexistent item", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ID: 9999, ProjectID: 1}
		_, _, err := si.CanRead(s, storageOwner)
		require.Error(t, err)
		assert.True(t, IsErrStorageItemDoesNotExist(err))
	})
}

func TestStorageItem_ReadAll(t *testing.T) {
	t.Run("returns only the project's items", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ProjectID: 1}
		result, _, total, err := si.ReadAll(s, storageOwner, "", 1, 50)
		require.NoError(t, err)

		items, ok := result.([]*StorageItem)
		require.True(t, ok)
		assert.Len(t, items, 2)
		assert.Equal(t, int64(2), total)
		for _, item := range items {
			assert.Equal(t, int64(1), item.ProjectID)
		}
	})

	// DoReadAll never calls CanRead, so ReadAll has to refuse by itself.
	t.Run("denied for a stranger", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ProjectID: 1}
		_, _, _, err := si.ReadAll(s, storageStranger, "", 1, 50)
		require.Error(t, err)
		assert.True(t, IsErrGenericForbidden(err))
	})

	t.Run("search filters by title", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ProjectID: 1}
		result, _, _, err := si.ReadAll(s, storageOwner, "link", 1, 50)
		require.NoError(t, err)

		items, ok := result.([]*StorageItem)
		require.True(t, ok)
		assert.Len(t, items, 1)
		assert.Equal(t, "Test link", items[0].Title)
	})
}

func TestStorageItem_Create(t *testing.T) {
	t.Run("link", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ProjectID: 1, Title: "Vikunja", URL: "https://vikunja.io"}
		require.NoError(t, si.Create(s, storageOwner))
		assert.Equal(t, StorageItemKindLink, si.Kind)
		assert.Positive(t, si.ID)
	})

	t.Run("title defaults to the url", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ProjectID: 1, URL: "https://vikunja.io/features"}
		require.NoError(t, si.Create(s, storageOwner))
		assert.Equal(t, "https://vikunja.io/features", si.Title)
	})

	// A javascript: or data: url would be a stored XSS for everyone who clicks it.
	t.Run("rejects non-http schemes", func(t *testing.T) {
		for _, bad := range []string{"javascript:alert(1)", "data:text/html;base64,x", "ftp://x.example", "not-a-url"} {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()

			si := &StorageItem{ProjectID: 1, Title: "bad", URL: bad}
			err := si.Create(s, storageOwner)
			require.Error(t, err, bad)
			assert.True(t, IsErrStorageItemInvalid(err), bad)
			_ = s.Close()
		}
	})

	t.Run("rejects an empty url", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ProjectID: 1, Title: "no url"}
		err := si.Create(s, storageOwner)
		require.Error(t, err)
		assert.True(t, IsErrStorageItemInvalid(err))
	})
}

func TestStorageItem_Update(t *testing.T) {
	t.Run("renames without touching the target", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ID: 2, ProjectID: 1, Title: "New name", URL: "https://evil.example"}
		require.NoError(t, si.Update(s, storageOwner))
		assert.Equal(t, "New name", si.Title)
		assert.Equal(t, "https://vikunja.io", si.URL, "the url must not be swappable through a rename")
	})

	t.Run("rejects an empty title", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		si := &StorageItem{ID: 2, ProjectID: 1, Title: "   "}
		err := si.Update(s, storageOwner)
		require.Error(t, err)
		assert.True(t, IsErrStorageItemInvalid(err))
	})
}

func TestStorageItem_IsPreviewableMime(t *testing.T) {
	// Anything served inline runs on our origin if the browser renders it, so
	// this allowlist is a security boundary, not a convenience.
	previewable := []string{
		"application/pdf",
		"text/plain",
		"text/plain; charset=utf-8",
		"TEXT/PLAIN",
		"image/png",
		"image/jpeg",
		"image/svg+xml",
		"video/mp4",
		"video/quicktime",
		"audio/mpeg",
	}
	for _, mime := range previewable {
		assert.True(t, IsPreviewableMime(mime), mime)
	}

	blocked := []string{
		"text/html",
		"text/html; charset=utf-8",
		"application/xhtml+xml",
		"text/xml",
		"application/xml",
		"application/javascript",
		"text/javascript",
		"application/zip",
		"application/octet-stream",
		"application/msword",
		"",
		"nonsense",
	}
	for _, mime := range blocked {
		assert.False(t, IsPreviewableMime(mime), mime)
	}
}

func TestStorageItemKind_ForFile(t *testing.T) {
	tests := []struct {
		filename string
		mime     string
		expected StorageItemKind
	}{
		{"a.png", "image/png", StorageItemKindImage},
		{"a.mp4", "video/mp4", StorageItemKindVideo},
		{"a.pdf", "application/pdf", StorageItemKindDocument},
		// Content sniffing often misreports these; the extension has to win.
		{"a.mp4", "text/plain", StorageItemKindVideo},
		{"a.HEIC", "application/octet-stream", StorageItemKindImage},
		{"no-extension", "application/octet-stream", StorageItemKindDocument},
	}

	for _, tt := range tests {
		assert.Equal(t, tt.expected, kindForFile(tt.filename, tt.mime), tt.filename)
	}
}
