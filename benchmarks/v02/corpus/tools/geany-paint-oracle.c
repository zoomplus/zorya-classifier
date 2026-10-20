#define _GNU_SOURCE
#include <dlfcn.h>
#include <gtk/gtk.h>
#include <stdlib.h>

typedef void (*gtk_init_fn)(int *, char ***);
typedef gboolean (*gtk_init_check_fn)(int *, char ***);

static const char *oracle_css =
    "toolbar toolbutton,\n"
    "toolbar toolbutton button,\n"
    "toolbar button,\n"
    "toolbar toolbutton:hover,\n"
    "toolbar toolbutton:active,\n"
    "toolbar toolbutton:checked,\n"
    "toolbar toolbutton:disabled,\n"
    "toolbar button:hover,\n"
    "toolbar button:active,\n"
    "toolbar button:checked,\n"
    "toolbar button:disabled {\n"
    "  background-image: none;\n"
    "  background-color: #00d020;\n"
    "  border: 2px solid #ff00ff;\n"
    "  border-radius: 0;\n"
    "  margin: 0;\n"
    "  box-shadow: none;\n"
    "  opacity: 1;\n"
    "}\n";

static gsize provider_installed = 0;

static void install_oracle_provider(void) {
    if (g_once_init_enter(&provider_installed)) {
        GdkScreen *screen = gdk_screen_get_default();
        if (screen != NULL) {
            GtkCssProvider *provider = gtk_css_provider_new();
            GError *error = NULL;
            if (gtk_css_provider_load_from_data(provider, oracle_css, -1, &error)) {
                gtk_style_context_add_provider_for_screen(
                    screen,
                    GTK_STYLE_PROVIDER(provider),
                    GTK_STYLE_PROVIDER_PRIORITY_USER + 100);
            }
            if (error != NULL) g_error_free(error);
            g_object_unref(provider);
        }
        g_once_init_leave(&provider_installed, 1);
    }
}

void gtk_init(int *argc, char ***argv) {
    static gtk_init_fn real_gtk_init = NULL;
    if (real_gtk_init == NULL) real_gtk_init = (gtk_init_fn)dlsym(RTLD_NEXT, "gtk_init");
    if (real_gtk_init == NULL) abort();
    real_gtk_init(argc, argv);
    install_oracle_provider();
}

gboolean gtk_init_check(int *argc, char ***argv) {
    static gtk_init_check_fn real_gtk_init_check = NULL;
    if (real_gtk_init_check == NULL) real_gtk_init_check = (gtk_init_check_fn)dlsym(RTLD_NEXT, "gtk_init_check");
    if (real_gtk_init_check == NULL) abort();
    gboolean initialized = real_gtk_init_check(argc, argv);
    if (initialized) install_oracle_provider();
    return initialized;
}
