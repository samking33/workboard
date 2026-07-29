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

package webtests

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHumaStorageItem(t *testing.T) {
	// project 1 is owned by testuser1.
	owned := webHandlerTestV2{
		user:     &testuser1,
		basePath: "/api/v2/projects/1/storage",
		idParam:  "storageitem",
		t:        t,
	}
	require.NoError(t, owned.ensureEnv())

	// project 2 is owned by user3; testuser1 has no access. Share owned's Echo
	// instance: each setupTestEnv() regenerates the global JWT signing secret,
	// so two independent harnesses would invalidate each other's tokens.
	forbidden := webHandlerTestV2{
		user:     &testuser1,
		basePath: "/api/v2/projects/2/storage",
		idParam:  "storageitem",
		t:        t,
		e:        owned.e,
	}

	// project 9 is shared to testuser1 read-only — enough to list, below the
	// write bar every mutation requires.
	readShared := webHandlerTestV2{
		user:     &testuser1,
		basePath: "/api/v2/projects/9/storage",
		idParam:  "storageitem",
		t:        t,
		e:        owned.e,
	}

	t.Run("ReadAll", func(t *testing.T) {
		t.Run("Normal", func(t *testing.T) {
			rec, err := owned.testReadAllWithUser(nil, nil)
			require.NoError(t, err)
			assert.Contains(t, rec.Body.String(), `"title":"Test document"`)
			assert.Contains(t, rec.Body.String(), `"title":"Test link"`)
			// The item in project 2 must never appear here.
			assert.NotContains(t, rec.Body.String(), `"title":"Other project document"`)
		})
		// DoReadAll does not call CanRead, so this asserts ReadAll's own check.
		t.Run("Forbidden", func(t *testing.T) {
			_, err := forbidden.testReadAllWithUser(nil, nil)
			require.Error(t, err)
			assert.Equal(t, http.StatusForbidden, getHTTPErrorCode(err))
		})
		t.Run("Shared read-only can list", func(t *testing.T) {
			_, err := readShared.testReadAllWithUser(nil, nil)
			require.NoError(t, err)
		})
	})

	t.Run("ReadOne", func(t *testing.T) {
		t.Run("Normal", func(t *testing.T) {
			rec, err := owned.testReadOneWithUser(nil, map[string]string{"storageitem": "1"})
			require.NoError(t, err)
			assert.Contains(t, rec.Body.String(), `"title":"Test document"`)
			assert.Contains(t, rec.Body.String(), `"max_permission":`)
			assert.NotEmpty(t, rec.Result().Header.Get("ETag"))
		})
		t.Run("Nonexisting", func(t *testing.T) {
			_, err := owned.testReadOneWithUser(nil, map[string]string{"storageitem": "9999"})
			require.Error(t, err)
			assert.Equal(t, http.StatusNotFound, getHTTPErrorCode(err))
		})
		// Item 3 belongs to project 2. Reaching it through project 1, which the
		// caller can read, must not disclose it.
		t.Run("Item of another project", func(t *testing.T) {
			_, err := owned.testReadOneWithUser(nil, map[string]string{"storageitem": "3"})
			require.Error(t, err)
			assert.Equal(t, http.StatusNotFound, getHTTPErrorCode(err))
		})
	})

	t.Run("Create", func(t *testing.T) {
		t.Run("Normal link", func(t *testing.T) {
			rec, err := owned.testCreateWithUser(nil, nil, `{"title":"Vikunja","url":"https://vikunja.io"}`)
			require.NoError(t, err)
			assert.Contains(t, rec.Body.String(), `"kind":"link"`)
		})
		t.Run("Rejects a javascript url", func(t *testing.T) {
			_, err := owned.testCreateWithUser(nil, nil, `{"title":"xss","url":"javascript:alert(1)"}`)
			require.Error(t, err)
			assert.Equal(t, http.StatusBadRequest, getHTTPErrorCode(err))
		})
		t.Run("Forbidden", func(t *testing.T) {
			_, err := forbidden.testCreateWithUser(nil, nil, `{"title":"nope","url":"https://vikunja.io"}`)
			require.Error(t, err)
			assert.Equal(t, http.StatusForbidden, getHTTPErrorCode(err))
		})
		t.Run("Read-only share cannot create", func(t *testing.T) {
			_, err := readShared.testCreateWithUser(nil, nil, `{"title":"nope","url":"https://vikunja.io"}`)
			require.Error(t, err)
			assert.Equal(t, http.StatusForbidden, getHTTPErrorCode(err))
		})
	})

	t.Run("Update", func(t *testing.T) {
		t.Run("Renames but keeps the target", func(t *testing.T) {
			rec, err := owned.testUpdateWithUser(nil, map[string]string{"storageitem": "2"},
				`{"title":"Renamed","url":"https://evil.example"}`)
			require.NoError(t, err)
			assert.Contains(t, rec.Body.String(), `"title":"Renamed"`)
			assert.Contains(t, rec.Body.String(), `"url":"https://vikunja.io"`)
			assert.NotContains(t, rec.Body.String(), "evil.example")
		})
		t.Run("Forbidden", func(t *testing.T) {
			_, err := forbidden.testUpdateWithUser(nil, map[string]string{"storageitem": "3"}, `{"title":"nope"}`)
			require.Error(t, err)
			assert.Equal(t, http.StatusForbidden, getHTTPErrorCode(err))
		})
	})

	t.Run("Preview", func(t *testing.T) {
		// Item 2 is a link, so there is no file to render.
		t.Run("Link has no file to preview", func(t *testing.T) {
			_, err := owned.serve(http.MethodGet, "/api/v2/projects/1/storage/2/preview", "")
			require.Error(t, err)
			assert.Equal(t, http.StatusBadRequest, getHTTPErrorCode(err))
		})
		t.Run("Forbidden", func(t *testing.T) {
			_, err := forbidden.serve(http.MethodGet, "/api/v2/projects/2/storage/3/preview", "")
			require.Error(t, err)
			assert.Equal(t, http.StatusForbidden, getHTTPErrorCode(err))
		})
		t.Run("Nonexisting", func(t *testing.T) {
			_, err := owned.serve(http.MethodGet, "/api/v2/projects/1/storage/9999/preview", "")
			require.Error(t, err)
			assert.Equal(t, http.StatusNotFound, getHTTPErrorCode(err))
		})
	})

	t.Run("Delete", func(t *testing.T) {
		t.Run("Normal", func(t *testing.T) {
			_, err := owned.testDeleteWithUser(nil, map[string]string{"storageitem": "2"})
			require.NoError(t, err)
		})
		t.Run("Forbidden", func(t *testing.T) {
			_, err := forbidden.testDeleteWithUser(nil, map[string]string{"storageitem": "3"})
			require.Error(t, err)
			assert.Equal(t, http.StatusForbidden, getHTTPErrorCode(err))
		})
	})
}
