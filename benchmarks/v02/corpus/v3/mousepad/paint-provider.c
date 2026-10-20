#define _GNU_SOURCE
#include <dlfcn.h>
#include <gtk/gtk.h>
#include <atk/atk.h>
#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
static void install(void){GdkScreen*s=gdk_screen_get_default();if(!s)return;GtkCssProvider*p=gtk_css_provider_new();GError*e=NULL;const char*css="toolbar button, .toolbar button, button {background-image:none;background-color:#00d020;border:2px solid #ff00ff;border-radius:0;margin:0;box-shadow:none;opacity:1;}";if(gtk_css_provider_load_from_data(p,css,-1,&e))gtk_style_context_add_provider_for_screen(s,GTK_STYLE_PROVIDER(p),GTK_STYLE_PROVIDER_PRIORITY_USER+100);if(e)g_error_free(e);g_object_unref(p);}
static void walk(GtkWidget*w,GtkWidget*top,FILE*f){AtkObject*a=gtk_widget_get_accessible(w);const char*n=a?atk_object_get_name(a):NULL;GtkAllocation al;gtk_widget_get_allocation(w,&al);gint tx=0,ty=0,ox=0,oy=0;gtk_widget_translate_coordinates(w,top,0,0,&tx,&ty);GdkWindow*gw=gtk_widget_get_window(top);if(gw)gdk_window_get_origin(gw,&ox,&oy);if(n&&*n)fprintf(f,"%s\t%s\t%s\t%d,%d,%d,%d\t%d,%d,%d,%d\n",n,G_OBJECT_TYPE_NAME(w),atk_role_get_name(atk_object_get_role(a)),al.x,al.y,al.width,al.height,ox+tx,oy+ty,al.width,al.height);if(GTK_IS_CONTAINER(w)){GList*children=gtk_container_get_children(GTK_CONTAINER(w));for(GList*l=children;l;l=l->next)if(GTK_IS_WIDGET(l->data))walk(GTK_WIDGET(l->data),top,f);g_list_free(children);}}
static gboolean dump(gpointer unused){const char*path=getenv("A6_GEOM_LOG");if(!path)return G_SOURCE_REMOVE;FILE*f=fopen(path,"a");if(!f)return G_SOURCE_REMOVE;GList*windows=gtk_window_list_toplevels();for(GList*l=windows;l;l=l->next){GtkWidget*w=GTK_WIDGET(l->data);walk(w,w,f);}g_list_free(windows);fclose(f);return G_SOURCE_REMOVE;}
typedef int(*run_fn)(GApplication*,int,char**);int g_application_run(GApplication*a,int argc,char**argv){static run_fn real=NULL;if(!real)real=dlsym(RTLD_NEXT,"g_application_run");if(!real)abort();if(gtk_init_check(NULL,NULL)){install();g_timeout_add(1500,dump,NULL);}return real(a,argc,argv);}
