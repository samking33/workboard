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
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"

	"github.com/danielgtaylor/huma/v2"
	"xorm.io/xorm"
)

// StorageItemKind is the section a storage item belongs to in the storage view.
type StorageItemKind int

const (
	StorageItemKindDocument StorageItemKind = iota
	StorageItemKindLink
	StorageItemKindImage
	StorageItemKindVideo
)

func (k *StorageItemKind) MarshalJSON() ([]byte, error) {
	switch *k {
	case StorageItemKindDocument:
		return []byte(`"document"`), nil
	case StorageItemKindLink:
		return []byte(`"link"`), nil
	case StorageItemKindImage:
		return []byte(`"image"`), nil
	case StorageItemKindVideo:
		return []byte(`"video"`), nil
	}

	return []byte(`null`), nil
}

func (k *StorageItemKind) UnmarshalJSON(bytes []byte) error {
	var value string
	if err := json.Unmarshal(bytes, &value); err != nil {
		return err
	}

	switch value {
	case "document":
		*k = StorageItemKindDocument
	case "link":
		*k = StorageItemKindLink
	case "image":
		*k = StorageItemKindImage
	case "video":
		*k = StorageItemKindVideo
	default:
		return fmt.Errorf("unknown storage item kind: %s", value)
	}

	return nil
}

// Schema lets Huma reflect this int as a string enum, matching the custom
// Marshal/UnmarshalJSON above. Same reasoning as ProjectViewKind.
func (*StorageItemKind) Schema(_ huma.Registry) *huma.Schema {
	return &huma.Schema{
		Type: "string",
		Enum: []any{"document", "link", "image", "video"},
	}
}

var imageExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".svg": true, ".bmp": true, ".tiff": true, ".heic": true, ".avif": true, ".ico": true,
}

var videoExtensions = map[string]bool{
	".mp4": true, ".mov": true, ".webm": true, ".mkv": true, ".avi": true,
	".m4v": true, ".mpg": true, ".mpeg": true, ".wmv": true,
}

// kindForFile sorts an upload into a section. The mime type is what the browser
// claimed, so it is only trusted to pick a tab — never to decide how the file is
// served back.
func kindForFile(filename, mime string) StorageItemKind {
	switch {
	case strings.HasPrefix(mime, "image/"):
		return StorageItemKindImage
	case strings.HasPrefix(mime, "video/"):
		return StorageItemKindVideo
	}

	ext := strings.ToLower(filepath.Ext(filename))
	switch {
	case imageExtensions[ext]:
		return StorageItemKindImage
	case videoExtensions[ext]:
		return StorageItemKindVideo
	}

	return StorageItemKindDocument
}

// IsPreviewableMime reports whether a stored file may be served with an inline
// Content-Disposition.
//
// This is a strict allowlist on purpose. Anything served inline from our own
// origin executes as us if the browser decides to render it, so text/html,
// XML-ish types and everything unknown stay downloads. SVG is allowed because
// the preview response is sandboxed by CSP and the frontend only ever renders
// images through <img>, where embedded scripts do not run.
func IsPreviewableMime(mime string) bool {
	base, _, _ := strings.Cut(mime, ";")
	base = strings.ToLower(strings.TrimSpace(base))

	switch {
	case base == "application/pdf",
		base == "text/plain":
		return true
	case strings.HasPrefix(base, "image/"),
		strings.HasPrefix(base, "video/"),
		strings.HasPrefix(base, "audio/"):
		return true
	}

	return false
}

// StorageItem is a file or link stored against a project, shown in its storage view.
type StorageItem struct {
	ID        int64 `xorm:"bigint autoincr not null unique pk" json:"id" param:"storageitem" readOnly:"true" doc:"The unique, numeric id of this storage item."`
	ProjectID int64 `xorm:"bigint not null index" json:"project_id" param:"project" readOnly:"true" doc:"The project this item belongs to. Taken from the URL, not the body."`

	Title string          `xorm:"varchar(250) not null" json:"title" valid:"runelength(1|250)" minLength:"1" maxLength:"250" doc:"Display name. Defaults to the file name for uploads and to the url for links."`
	Kind  StorageItemKind `xorm:"not null index" json:"kind" swaggertype:"string" enums:"document,link,image,video" readOnly:"true" doc:"Which section the item belongs to. Derived from the upload's type, or link when a url is given."`

	URL string `xorm:"text null" json:"url" doc:"The target of a link item. Must be http(s). Empty for uploaded files."`

	FileID int64       `xorm:"bigint null" json:"-"`
	File   *files.File `xorm:"-" json:"file" readOnly:"true" doc:"Metadata of the stored file (name, mime, size). Null for links. Bytes come from the download endpoint."`

	CreatedByID int64      `xorm:"bigint not null" json:"-"`
	CreatedBy   *user.User `xorm:"-" json:"created_by" readOnly:"true" doc:"The user who added this item."`

	Created time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"A timestamp when this item was added. You cannot change this value."`
	Updated time.Time `xorm:"updated not null" json:"updated" readOnly:"true" doc:"A timestamp when this item was last changed. You cannot change this value."`

	web.CRUDable    `xorm:"-" json:"-"`
	web.Permissions `xorm:"-" json:"-"`
}

func (*StorageItem) TableName() string {
	return "storage_items"
}

func getStorageItemByID(s *xorm.Session, id int64) (item *StorageItem, err error) {
	item = &StorageItem{}
	exists, err := s.Where("id = ?", id).Get(item)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, &ErrStorageItemDoesNotExist{StorageItemID: id}
	}
	return item, nil
}

// addFileAndUser loads the relations which aren't stored on the row itself.
func (si *StorageItem) addFileAndUser(s *xorm.Session) (err error) {
	if si.FileID > 0 && si.File == nil {
		si.File = &files.File{ID: si.FileID}
		if err = si.File.LoadFileMetaByID(); err != nil {
			// A missing blob shouldn't hide the whole item — the row is still
			// useful to see and delete.
			if !files.IsErrFileDoesNotExist(err) {
				return err
			}
			si.File = nil
		}
	}

	if si.CreatedBy == nil && si.CreatedByID > 0 {
		si.CreatedBy, err = user.GetUserByID(s, si.CreatedByID)
		if err != nil && !user.IsErrUserDoesNotExist(err) {
			return err
		}
	}

	return nil
}

// deleteStorageItemsForProject drops a project's storage items along with the
// blobs behind them. Without this, deleting a project orphans the files on disk.
func deleteStorageItemsForProject(s *xorm.Session, projectID int64) (err error) {
	items := []*StorageItem{}
	if err = s.Where("project_id = ?", projectID).Find(&items); err != nil {
		return err
	}

	if _, err = s.Where("project_id = ?", projectID).Delete(&StorageItem{}); err != nil {
		return err
	}

	for _, item := range items {
		if item.FileID == 0 {
			continue
		}
		file := &files.File{ID: item.FileID}
		if err = file.Delete(s); err != nil && !files.IsErrFileDoesNotExist(err) {
			return err
		}
	}

	return nil
}

// ReadAll returns all storage items of a project.
// @Summary Get all storage items of a project
// @Description Returns all files and links stored against a project.
// @tags storage
// @Accept json
// @Produce json
// @Param project path int true "Project ID"
// @Security JWTKeyAuth
// @Success 200 {array} models.StorageItem "The storage items"
// @Failure 500 {object} models.Message "Internal error"
// @Router /projects/{project}/storage [get]
func (si *StorageItem) ReadAll(s *xorm.Session, a web.Auth, search string, page int, perPage int) (result interface{}, resultCount int, numberOfTotalItems int64, err error) {
	// DoReadAll does not call CanRead, so the permission check has to happen
	// here — otherwise any project id can be read by guessing it.
	p := &Project{ID: si.ProjectID}
	canRead, _, err := p.CanRead(s, a)
	if err != nil {
		return nil, 0, 0, err
	}
	if !canRead {
		return nil, 0, 0, ErrGenericForbidden{}
	}

	query := s.Where("project_id = ?", si.ProjectID)
	if search != "" {
		query = query.And("title LIKE ?", "%"+search+"%")
	}

	limit, start := getLimitFromPageIndex(page, perPage)
	if limit > 0 {
		query = query.Limit(limit, start)
	}

	items := []*StorageItem{}
	err = query.OrderBy("created DESC").Find(&items)
	if err != nil {
		return nil, 0, 0, err
	}

	for _, item := range items {
		if err = item.addFileAndUser(s); err != nil {
			return nil, 0, 0, err
		}
	}

	countQuery := s.Where("project_id = ?", si.ProjectID)
	if search != "" {
		countQuery = countQuery.And("title LIKE ?", "%"+search+"%")
	}
	total, err := countQuery.Count(&StorageItem{})
	if err != nil {
		return nil, 0, 0, err
	}

	return items, len(items), total, nil
}

// ReadOne returns one storage item.
// @Summary Get one storage item
// @Description Returns a single file or link stored against a project.
// @tags storage
// @Accept json
// @Produce json
// @Param project path int true "Project ID"
// @Param storageitem path int true "Storage item ID"
// @Security JWTKeyAuth
// @Success 200 {object} models.StorageItem "The storage item"
// @Failure 404 {object} web.HTTPError "The storage item does not exist."
// @Router /projects/{project}/storage/{storageitem} [get]
func (si *StorageItem) ReadOne(s *xorm.Session, _ web.Auth) (err error) {
	return si.addFileAndUser(s)
}

// Create adds a link to a project's storage. Files are uploaded through the
// dedicated upload route instead, since they arrive as multipart rather than JSON.
// @Summary Add a link to a project's storage
// @Description Stores a link against a project. Use the upload endpoint for files.
// @tags storage
// @Accept json
// @Produce json
// @Param project path int true "Project ID"
// @Param item body models.StorageItem true "The link to add"
// @Security JWTKeyAuth
// @Success 201 {object} models.StorageItem "The created storage item"
// @Failure 400 {object} web.HTTPError "Invalid storage item"
// @Router /projects/{project}/storage [put]
func (si *StorageItem) Create(s *xorm.Session, a web.Auth) (err error) {
	si.URL = strings.TrimSpace(si.URL)
	if si.URL == "" {
		return &ErrStorageItemInvalid{Reason: "a url is required, upload files through the upload endpoint"}
	}

	parsed, err := url.Parse(si.URL)
	// Anything but http(s) can smuggle javascript: or data: payloads into a
	// link the whole team then clicks.
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return &ErrStorageItemInvalid{Reason: "url must be an absolute http or https address"}
	}

	si.Kind = StorageItemKindLink
	si.FileID = 0
	si.File = nil

	si.Title = strings.TrimSpace(si.Title)
	if si.Title == "" {
		si.Title = si.URL
	}
	if len([]rune(si.Title)) > 250 {
		si.Title = string([]rune(si.Title)[:250])
	}

	si.CreatedBy, err = GetUserOrLinkShareUser(s, a)
	if err != nil {
		return err
	}
	si.CreatedByID = si.CreatedBy.ID

	_, err = s.Insert(si)
	return err
}

// NewFileItem stores an uploaded file against the project and records it.
func (si *StorageItem) NewFileItem(s *xorm.Session, f io.ReadSeeker, realname string, realsize uint64, a web.Auth) (err error) {
	file, err := files.CreateWithSession(s, f, realname, realsize, a)
	if err != nil {
		if files.IsErrFileIsTooLarge(err) {
			return ErrTaskAttachmentIsTooLarge{Size: realsize}
		}
		return err
	}

	si.File = file
	si.FileID = file.ID
	si.Kind = kindForFile(realname, file.Mime)
	if strings.TrimSpace(si.Title) == "" {
		si.Title = realname
	}
	if len([]rune(si.Title)) > 250 {
		si.Title = string([]rune(si.Title)[:250])
	}
	si.URL = ""

	si.CreatedBy, err = GetUserOrLinkShareUser(s, a)
	if err != nil {
		return si.cleanupFile(s, file, err)
	}
	si.CreatedByID = si.CreatedBy.ID

	if _, err = s.Insert(si); err != nil {
		return si.cleanupFile(s, file, err)
	}

	return nil
}

// StorageItemToUpload is one file of a multipart upload.
type StorageItemToUpload struct {
	Reader   io.ReadSeeker
	Filename string
	Size     uint64
}

// UploadStorageItems stores several uploads against a project. Each file is
// handled independently so one oversized file doesn't discard the rest.
func UploadStorageItems(s *xorm.Session, a web.Auth, projectID int64, uploads []*StorageItemToUpload) (success []*StorageItem, failures []error, err error) {
	si := &StorageItem{ProjectID: projectID}
	can, err := si.CanCreate(s, a)
	if err != nil {
		return nil, nil, err
	}
	if !can {
		return nil, nil, ErrGenericForbidden{}
	}

	for _, upload := range uploads {
		item := &StorageItem{ProjectID: projectID}
		if err := item.NewFileItem(s, upload.Reader, upload.Filename, upload.Size, a); err != nil {
			failures = append(failures, err)
			continue
		}
		success = append(success, item)
	}

	return success, failures, nil
}

// LoadStorageItemForDownload checks read access and opens the item's file. The
// caller owns the session, the commit and writing the response.
func LoadStorageItemForDownload(s *xorm.Session, a web.Auth, projectID, itemID int64) (si *StorageItem, err error) {
	si = &StorageItem{ID: itemID, ProjectID: projectID}
	can, _, err := si.CanRead(s, a)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, ErrGenericForbidden{}
	}

	if err = si.addFileAndUser(s); err != nil {
		return nil, err
	}
	if si.File == nil {
		return nil, &ErrStorageItemInvalid{Reason: "this item is a link, it has no file to download"}
	}
	if err = si.File.LoadFileByID(); err != nil {
		return nil, err
	}

	return si, nil
}

// LoadStorageItemForPreview is LoadStorageItemForDownload plus the inline-safety
// check, so a type we refuse to render never reaches the response writer.
func LoadStorageItemForPreview(s *xorm.Session, a web.Auth, projectID, itemID int64) (si *StorageItem, err error) {
	si, err = LoadStorageItemForDownload(s, a, projectID, itemID)
	if err != nil {
		return nil, err
	}

	if !IsPreviewableMime(si.File.Mime) {
		return nil, &ErrStorageItemNotPreviewable{StorageItemID: itemID, Mime: si.File.Mime}
	}

	return si, nil
}

// cleanupFile removes a just-stored blob when recording it in the db failed, so
// a failed upload doesn't leave an orphan on disk.
func (si *StorageItem) cleanupFile(s *xorm.Session, file *files.File, cause error) error {
	if err := file.Delete(s); err != nil {
		return err
	}
	return cause
}

// Update renames a storage item. Only the title is changeable — swapping the
// file or url of an existing item would silently change what everyone else sees.
// @Summary Rename a storage item
// @Description Changes the display name of a storage item. The file or url itself cannot be swapped.
// @tags storage
// @Accept json
// @Produce json
// @Param project path int true "Project ID"
// @Param storageitem path int true "Storage item ID"
// @Param item body models.StorageItem true "The item with its new title"
// @Security JWTKeyAuth
// @Success 200 {object} models.StorageItem "The updated storage item"
// @Router /projects/{project}/storage/{storageitem} [post]
func (si *StorageItem) Update(s *xorm.Session, _ web.Auth) (err error) {
	si.Title = strings.TrimSpace(si.Title)
	if si.Title == "" {
		return &ErrStorageItemInvalid{Reason: "title cannot be empty"}
	}
	if len([]rune(si.Title)) > 250 {
		si.Title = string([]rune(si.Title)[:250])
	}

	if _, err = s.Where("id = ?", si.ID).Cols("title").Update(si); err != nil {
		return err
	}

	stored, err := getStorageItemByID(s, si.ID)
	if err != nil {
		return err
	}
	*si = *stored

	return si.addFileAndUser(s)
}

// Delete removes a storage item and its file.
// @Summary Delete a storage item
// @Description Removes a storage item. For uploads the stored file is deleted too.
// @tags storage
// @Accept json
// @Produce json
// @Param project path int true "Project ID"
// @Param storageitem path int true "Storage item ID"
// @Security JWTKeyAuth
// @Success 200 {object} models.Message "The storage item was deleted"
// @Router /projects/{project}/storage/{storageitem} [delete]
func (si *StorageItem) Delete(s *xorm.Session, _ web.Auth) (err error) {
	if _, err = s.Where("id = ?", si.ID).Delete(&StorageItem{}); err != nil {
		return err
	}

	if si.FileID == 0 {
		return nil
	}

	file := &files.File{ID: si.FileID}
	err = file.Delete(s)
	// The row is already gone; a missing blob is not worth failing the request over.
	if err != nil && files.IsErrFileDoesNotExist(err) {
		return nil
	}
	return err
}
