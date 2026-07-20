__copyright__ = "Copyright 2026"
__author__ = "UCL Laws"
__license__ = "AGPL v3"

from django.urls import path

from plugins.lawsnotes import views


urlpatterns = [
    # Mounted by core/include_urls.py at /plugins/lawsnotes/manager/.
    path("manager/", views.manage, name="lawsnotes_manager"),
    # Configure page for the Latest Articles homepage element.
    # Linked to from the homepage manager via HomepageElement.configure_url.
    path(
        "configure/latest-articles/",
        views.configure_latest_articles,
        name="lawsnotes_configure_latest",
    ),
    # JSON metadata for card lists (abstracts + issue authors). The
    # JS batches one request per page rather than scraping each
    # article/issue page individually -- ~99% less transfer, far
    # cheaper server-side (one SQL query, no template rendering).
    path("api/cards/", views.card_metadata, name="lawsnotes_api_cards"),
]
