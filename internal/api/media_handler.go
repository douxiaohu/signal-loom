package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"telegram-radar/internal/media"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
)

// mediaWriteTimeout lifts the server-wide WriteTimeout for media: a video may
// be large and the reader may be slow.
const mediaWriteTimeout = 10 * time.Minute

// mediaServer is shared by the public and the admin media endpoints. The
// endpoints differ only in who may call them and in caching; everything else,
// including how an index maps to a file, is identical, so both go through here.
type mediaServer struct {
	messages *repository.MessageRepository
	cache    *media.Cache
}

type mediaRequest struct {
	msg       *model.StoredMessage
	index     int
	thumbnail bool
}

// lookup resolves /media/{id}/{index}?variant=... to a stored message. It does
// not decide whether the caller may see the message: that is the endpoint's job.
func (m *mediaServer) lookup(r *http.Request) (*mediaRequest, *apiError, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		return nil, &apiError{http.StatusNotFound, "Media not found"}, nil
	}
	index, err := strconv.Atoi(chi.URLParam(r, "index"))
	if err != nil || index < 0 {
		return nil, &apiError{http.StatusNotFound, "Media not found"}, nil
	}
	thumbnail := true // like the Python service, thumbnails are the default
	switch r.URL.Query().Get("variant") {
	case "", "thumbnail":
	case "original":
		thumbnail = false
	default:
		return nil, &apiError{http.StatusBadRequest, "variant must be thumbnail or original"}, nil
	}
	msg, err := m.messages.GetMessageByID(id)
	if err != nil {
		return nil, nil, err
	}
	if msg == nil {
		return nil, &apiError{http.StatusNotFound, "Media not found"}, nil
	}
	return &mediaRequest{msg: msg, index: index, thumbnail: thumbnail}, nil, nil
}

// serve downloads (or finds) the file and streams it.
func (m *mediaServer) serve(w http.ResponseWriter, r *http.Request, req *mediaRequest, cacheControl string) {
	items := model.ParseRawMessage(req.msg.RawJSON).Items(req.msg.MediaType)
	if req.index >= len(items) {
		RespondError(w, http.StatusNotFound, "Media not found")
		return
	}

	// The download may take a while and the transfer longer still.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(mediaWriteTimeout))

	f, res, err := m.cache.Open(r.Context(), media.Ref{
		ChatID:    req.msg.ChatID,
		MessageID: req.msg.ID,
		Index:     req.index,
		URL:       items[req.index].URL,
	}, req.thumbnail)
	if err != nil {
		m.writeError(w, r, err)
		return
	}

	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		internalError(w, r, err)
		return
	}
	// The type was validated when the file was stored; it is stated explicitly
	// so nothing is guessed from the file name.
	w.Header().Set("Content-Type", res.ContentType)
	w.Header().Set("Cache-Control", cacheControl)
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func (m *mediaServer) writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, media.ErrNotFound):
		RespondError(w, http.StatusNotFound, "Media not found")
	case errors.Is(err, media.ErrURLRejected):
		RespondError(w, http.StatusBadRequest, "Media URL is not allowed")
	case errors.Is(err, media.ErrUnsupportedType):
		RespondError(w, http.StatusBadRequest, "Unsupported media type")
	case errors.Is(err, media.ErrTooLarge):
		RespondError(w, http.StatusBadRequest, "Media file is too large")
	case errors.Is(err, context.Canceled):
		// The client went away; nobody is listening for a response.
	default:
		log.Printf("[media] %s: %v", r.URL.Path, err)
		RespondError(w, http.StatusBadGateway, "Failed to fetch media")
	}
}
