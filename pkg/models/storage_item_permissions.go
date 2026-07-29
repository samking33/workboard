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
	"code.vikunja.io/api/pkg/web"

	"xorm.io/xorm"
)

// Storage items inherit their permissions from the project holding them: seeing
// a project means seeing its storage, writing to it means managing its storage.

func (si *StorageItem) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	if err := si.loadForPermissionCheck(s); err != nil {
		return false, 0, err
	}

	p := &Project{ID: si.ProjectID}
	return p.CanRead(s, a)
}

func (si *StorageItem) CanCreate(s *xorm.Session, a web.Auth) (bool, error) {
	p := &Project{ID: si.ProjectID}
	return p.CanWrite(s, a)
}

func (si *StorageItem) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	return si.canWriteExisting(s, a)
}

func (si *StorageItem) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	return si.canWriteExisting(s, a)
}

// canWriteExisting loads the item first so the caller cannot reach another
// project's item by passing a project id it happens to have access to.
func (si *StorageItem) canWriteExisting(s *xorm.Session, a web.Auth) (bool, error) {
	if err := si.loadForPermissionCheck(s); err != nil {
		return false, err
	}

	p := &Project{ID: si.ProjectID}
	return p.CanWrite(s, a)
}

func (si *StorageItem) loadForPermissionCheck(s *xorm.Session) (err error) {
	if si.ID == 0 {
		return nil
	}

	stored, err := getStorageItemByID(s, si.ID)
	if err != nil {
		return err
	}

	if si.ProjectID != 0 && si.ProjectID != stored.ProjectID {
		return &ErrStorageItemDoesNotExist{StorageItemID: si.ID}
	}

	// Keep the caller-supplied title (Update needs it) but take everything that
	// decides access, and the file, from the row.
	title := si.Title
	*si = *stored
	if title != "" {
		si.Title = title
	}

	return nil
}
