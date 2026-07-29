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

package apiv2

import (
	"context"
	"fmt"
	"net/http"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	webfiles "code.vikunja.io/api/pkg/web/files"
	"code.vikunja.io/api/pkg/web/handler"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humaecho"
	"github.com/danielgtaylor/huma/v2/conditional"
)

type storageItemListBody struct {
	Body Paginated[*models.StorageItem]
}

type storageItemUploadInput struct {
	ProjectID int64 `path:"project" doc:"The id of the project to store the files in."`
	// Byte-level mime detection happens in files.CreateWithSession, so there is
	// no part content-type allow-list to enforce here.
	RawBody huma.MultipartFormFiles[struct {
		Files []huma.FormFile `form:"files" required:"true" doc:"One or more files to store. Send multiple parts under the same \"files\" field to upload several at once."`
	}]
}

type storageItemUploadBody struct {
	Body *storageUploadResult
}

type storageUploadResult struct {
	Success []*models.StorageItem `json:"success" doc:"The items which were stored."`
	Errors  []string              `json:"errors" doc:"One message per file which could not be stored. The other files in the same request still succeeded."`
}

func RegisterStorageItemRoutes(api huma.API) {
	tags := []string{"storage"}

	Register(api, huma.Operation{
		OperationID: "storage-items-list",
		Summary:     "List the storage items of a project",
		Description: "Returns the files and links stored against a project, newest first. Requires read access to the project. Filter to one section of the storage view with the kind parameter.",
		Method:      http.MethodGet,
		Path:        "/projects/{project}/storage",
		Tags:        tags,
	}, storageItemsList)

	Register(api, huma.Operation{
		OperationID: "storage-items-read",
		Summary:     "Get a single storage item",
		Description: "Returns one storage item. It must belong to the project in the path. Sends an ETag; pass it as If-None-Match on a later read to get a 304 Not Modified.",
		Method:      http.MethodGet,
		Path:        "/projects/{project}/storage/{storageitem}",
		Tags:        tags,
	}, storageItemsRead)

	Register(api, huma.Operation{
		OperationID: "storage-items-create",
		Summary:     "Add a link to a project's storage",
		Description: "Stores a link against a project. The url must be an absolute http or https address. Requires write access. Files are added through the upload endpoint instead, since they arrive as multipart rather than JSON.",
		Method:      http.MethodPost,
		Path:        "/projects/{project}/storage",
		Tags:        tags,
	}, storageItemsCreate)

	Register(api, huma.Operation{
		OperationID: "storage-items-update",
		Summary:     "Rename a storage item",
		Description: "Changes a storage item's display name. The file or url behind it cannot be swapped, so everyone keeps seeing the thing they were shown. Requires write access.",
		Method:      http.MethodPut,
		Path:        "/projects/{project}/storage/{storageitem}",
		Tags:        tags,
	}, storageItemsUpdate)

	Register(api, huma.Operation{
		OperationID: "storage-items-upload",
		Summary:     "Upload files to a project's storage",
		Description: "Stores one or more files against a project via multipart/form-data under the \"files\" field. Requires write access. Each file is sorted into the documents, images or videos section from its detected type. Files are processed independently: one that fails (for example, exceeding the server's size limit) is reported in the errors list while the rest still succeed, so the request returns 201 even on a partial upload.",
		Method:      http.MethodPost,
		Path:        "/projects/{project}/storage/upload",
		Tags:        tags,
		// +2 MB mirrors Echo's global BodyLimit overhead so a max-sized file isn't rejected by multipart boundary/header bytes.
		// #nosec G115 - configured value won't exceed int64 max in practice.
		MaxBodyBytes: (int64(config.GetMaxFileSizeInMBytes()) + 2) * 1024 * 1024,
	}, storageItemsUpload)

	Register(api, huma.Operation{
		OperationID: "storage-items-download",
		Summary:     "Download a stored file",
		Description: "Returns the raw bytes of a stored file. Requires read access to the project. Link items have no file and return 400. The response is always sent as an attachment with the file's detected mime type.",
		Method:      http.MethodGet,
		Path:        "/projects/{project}/storage/{storageitem}/download",
		Tags:        tags,
		// Spell out the binary response; a bare []byte Body would otherwise be
		// modeled as a base64 JSON string instead of binary file data.
		Responses: map[string]*huma.Response{
			"200": {
				Description: "The stored file's bytes. The Content-Type header carries the file's mime type.",
				Content: map[string]*huma.MediaType{
					"application/octet-stream": {
						Schema: &huma.Schema{Type: huma.TypeString, Format: "binary"},
					},
				},
			},
		},
	}, storageItemsDownload)

	Register(api, huma.Operation{
		OperationID: "storage-items-preview",
		Summary:     "Preview a stored file inline",
		Description: "Returns a stored file with an inline Content-Disposition so it can be rendered in the browser. Requires read access to the project. Only images, video, audio, PDF and plain text are served this way — anything else returns 415 and must be downloaded instead, because rendering it inline from this origin would let it execute as the application. The response is sandboxed by Content-Security-Policy and supports range requests, so video and audio can seek.",
		Method:      http.MethodGet,
		Path:        "/projects/{project}/storage/{storageitem}/preview",
		Tags:        tags,
		// Spell out the binary response; a bare []byte Body would otherwise be
		// modeled as a base64 JSON string instead of binary file data.
		Responses: map[string]*huma.Response{
			"200": {
				Description: "The file bytes, served inline. The Content-Type header carries the file's mime type.",
				Content: map[string]*huma.MediaType{
					"application/octet-stream": {
						Schema: &huma.Schema{Type: huma.TypeString, Format: "binary"},
					},
				},
			},
		},
	}, storageItemsPreview)

	Register(api, huma.Operation{
		OperationID: "storage-items-delete",
		Summary:     "Delete a storage item",
		Description: "Removes a storage item from the project. For uploads the stored file is deleted too. Requires write access.",
		Method:      http.MethodDelete,
		Path:        "/projects/{project}/storage/{storageitem}",
		Tags:        tags,
	}, storageItemsDelete)
}

func init() { AddRouteRegistrar(RegisterStorageItemRoutes) }

func storageItemsList(ctx context.Context, in *struct {
	ProjectID int64 `path:"project"`
	ListParams
}) (*storageItemListBody, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	result, _, total, err := handler.DoReadAll(ctx, &models.StorageItem{ProjectID: in.ProjectID}, a, in.Q, in.Page, in.PerPage)
	if err != nil {
		return nil, translateDomainError(err)
	}

	items, ok := result.([]*models.StorageItem)
	if !ok {
		return nil, fmt.Errorf("storageItems.ReadAll returned unexpected type %T (expected []*models.StorageItem)", result)
	}

	return &storageItemListBody{Body: NewPaginated(items, total, in.Page, in.PerPage)}, nil
}

type storageItemReadBody struct {
	models.StorageItem
	MaxPermission models.Permission `json:"max_permission" readOnly:"true" doc:"The maximum permission the requesting user has on this item's project (0=read, 1=read/write, 2=admin)."`
}

func storageItemsRead(ctx context.Context, in *struct {
	ProjectID int64 `path:"project"`
	ID        int64 `path:"storageitem"`
	conditional.Params
}) (*singleReadBody[storageItemReadBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	item := &models.StorageItem{ID: in.ID, ProjectID: in.ProjectID}
	maxPermission, err := handler.DoReadOne(ctx, item, a)
	if err != nil {
		return nil, translateDomainError(err)
	}

	body := &storageItemReadBody{StorageItem: *item, MaxPermission: models.Permission(maxPermission)}
	return conditionalReadResponse(&in.Params, body, item.Updated, maxPermission)
}

func storageItemsCreate(ctx context.Context, in *struct {
	ProjectID int64 `path:"project"`
	Body      models.StorageItem
}) (*singleBody[models.StorageItem], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	in.Body.ProjectID = in.ProjectID // URL wins over body
	if err := handler.DoCreate(ctx, &in.Body, a); err != nil {
		return nil, translateDomainError(err)
	}

	return &singleBody[models.StorageItem]{Body: &in.Body}, nil
}

func storageItemsUpdate(ctx context.Context, in *struct {
	ProjectID int64 `path:"project"`
	ID        int64 `path:"storageitem"`
	Body      storageItemReadBody
}) (*singleBody[models.StorageItem], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	item := &in.Body.StorageItem
	item.ID = in.ID               // URL wins over body
	item.ProjectID = in.ProjectID // parent from the path scopes the update
	if err := handler.DoUpdate(ctx, item, a); err != nil {
		return nil, translateDomainError(err)
	}

	return &singleBody[models.StorageItem]{Body: item}, nil
}

func storageItemsUpload(ctx context.Context, in *storageItemUploadInput) (*storageItemUploadBody, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	s := db.NewSession()
	defer s.Close()

	formFiles := in.RawBody.Data().Files
	uploads := make([]*models.StorageItemToUpload, 0, len(formFiles))
	for _, file := range formFiles {
		uploads = append(uploads, &models.StorageItemToUpload{
			Reader:   file,
			Filename: file.Filename,
			// #nosec G115 - multipart sizes are non-negative.
			Size: uint64(file.Size),
		})
	}

	success, failures, err := models.UploadStorageItems(s, a, in.ProjectID, uploads)
	if err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}

	if err := s.Commit(); err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}

	messages := make([]string, 0, len(failures))
	for _, failure := range failures {
		messages = append(messages, failure.Error())
	}
	if success == nil {
		success = []*models.StorageItem{}
	}

	return &storageItemUploadBody{Body: &storageUploadResult{Success: success, Errors: messages}}, nil
}

func storageItemsDownload(ctx context.Context, in *struct {
	ProjectID int64 `path:"project" doc:"The id of the project the item belongs to."`
	ID        int64 `path:"storageitem" doc:"The id of the storage item to download."`
}) (*huma.StreamResponse, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	s := db.NewSession()
	defer s.Close()

	item, err := models.LoadStorageItemForDownload(s, a, in.ProjectID, in.ID)
	if err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}

	// The reader comes from object storage, not the DB session, so it stays
	// valid after the commit; the StreamResponse callback runs after this returns.
	if err := s.Commit(); err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}

	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		c := humaecho.Unwrap(hctx)
		webfiles.WriteFileDownload((*c).Response(), (*c).Request(), item.File)
	}}, nil
}

func storageItemsPreview(ctx context.Context, in *struct {
	ProjectID int64 `path:"project" doc:"The id of the project the item belongs to."`
	ID        int64 `path:"storageitem" doc:"The id of the storage item to preview."`
}) (*huma.StreamResponse, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	s := db.NewSession()
	defer s.Close()

	item, err := models.LoadStorageItemForPreview(s, a, in.ProjectID, in.ID)
	if err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}

	// The reader comes from object storage, not the DB session, so it stays
	// valid after the commit; the StreamResponse callback runs after this returns.
	if err := s.Commit(); err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}

	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		c := humaecho.Unwrap(hctx)
		webfiles.WriteFilePreview((*c).Response(), (*c).Request(), item.File)
	}}, nil
}

func storageItemsDelete(ctx context.Context, in *struct {
	ProjectID int64 `path:"project"`
	ID        int64 `path:"storageitem"`
}) (*emptyBody, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	if err := handler.DoDelete(ctx, &models.StorageItem{ID: in.ID, ProjectID: in.ProjectID}, a); err != nil {
		return nil, translateDomainError(err)
	}

	return &emptyBody{}, nil
}
