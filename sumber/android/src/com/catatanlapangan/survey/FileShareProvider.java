package com.catatanlapangan.survey;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;

/**
 * Hands single files from the app's cache to other apps (the camera writes a photo,
 * Google Earth reads an exported KMZ). Not exported: access only through a one-off grant.
 */
public class FileShareProvider extends ContentProvider {
    static final String AUTHORITY = "com.catatanlapangan.survey.files";
    static final String CAMERA = "camera", SHARE = "share";

    static File dir(Context c, String kind) {
        File d = new File(c.getCacheDir(), kind);
        d.mkdirs();
        return d;
    }

    static Uri uriFor(String kind, String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(kind).appendPath(name).build();
    }

    static File fileFor(Context c, Uri uri) {
        List<String> seg = uri.getPathSegments();
        if (seg.size() != 2) return null;
        String kind = seg.get(0), name = seg.get(1);
        if (!(CAMERA.equals(kind) || SHARE.equals(kind))) return null;
        if (name.contains("/") || name.contains("..") || name.isEmpty()) return null;
        return new File(dir(c, kind), name);
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(getContext(), uri);
        if (f == null) throw new FileNotFoundException();
        boolean write = mode.contains("w");
        // Only the camera folder may be written to, and only by the camera app we asked.
        if (write && !CAMERA.equals(uri.getPathSegments().get(0))) throw new FileNotFoundException();
        int m = write ? ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE
                      : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(f, m);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f = fileFor(getContext(), uri);
        if (f == null) return null;
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        c.addRow(new Object[]{f.getName(), f.length()});
        return c;
    }

    @Override
    public String getType(Uri uri) {
        File f = fileFor(getContext(), uri);
        return f == null ? null : MainActivity.safeMime(f.getName());
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
